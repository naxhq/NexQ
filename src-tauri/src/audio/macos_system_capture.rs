use std::cell::UnsafeCell;
use std::ffi::{c_char, c_void};
use std::mem::{size_of, MaybeUninit};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc as sync_mpsc, Arc};
use std::time::Duration;

use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use coreaudio_sys::*;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::msg_send;
use tokio::sync::mpsc;

use super::super::AudioChunk;

type CreateTap = unsafe extern "C" fn(*mut AnyObject, *mut AudioObjectID) -> OSStatus;
type DestroyTap = unsafe extern "C" fn(AudioObjectID) -> OSStatus;

#[link(name = "System")]
extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

pub(super) fn start(
    tx: mpsc::Sender<AudioChunk>,
    stop: Arc<AtomicBool>,
    device_name: Option<String>,
) -> Result<std::thread::JoinHandle<()>, String> {
    let (ready_tx, ready_rx) = sync_mpsc::sync_channel(1);
    let handle = std::thread::Builder::new()
        .name("system-audio-capture".into())
        .spawn(move || {
            objc2::rc::autoreleasepool(|_| {
                if let Err(error) = run(tx, stop, device_name, &ready_tx) {
                    let _ = ready_tx.send(Err(error.clone()));
                    log::error!("System audio capture failed: {error}");
                }
            });
        })
        .map_err(|error| format!("Failed to spawn system capture thread: {error}"))?;
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(handle),
        Ok(Err(error)) => {
            let _ = handle.join();
            Err(error)
        }
        Err(error) => {
            let _ = handle.join();
            Err(format!("System audio capture initialization failed: {error}"))
        }
    }
}

fn check(status: OSStatus, operation: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!(
            "{operation} failed (CoreAudio status {status}). Allow NexQ system audio recording in System Settings > Privacy & Security."
        ))
    }
}

fn address(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: scope,
        mElement: 0,
    }
}

fn property<T>(object: AudioObjectID, selector: u32, scope: u32) -> Result<T, String> {
    let mut value = MaybeUninit::<T>::uninit();
    let mut size = size_of::<T>() as u32;
    check(unsafe {
        AudioObjectGetPropertyData(
            object, &address(selector, scope), 0, ptr::null(), &mut size,
            value.as_mut_ptr().cast(),
        )
    }, &format!("Reading audio property {selector:#x}"))?;
    if size as usize != size_of::<T>() {
        return Err("CoreAudio returned an unexpected property size".into());
    }
    Ok(unsafe { value.assume_init() })
}

fn object_list(object: AudioObjectID, selector: u32, scope: u32) -> Result<Vec<u32>, String> {
    let address = address(selector, scope);
    let mut size = 0;
    check(unsafe {
        AudioObjectGetPropertyDataSize(object, &address, 0, ptr::null(), &mut size)
    }, "Reading audio object list size")?;
    if size as usize % size_of::<u32>() != 0 {
        return Err("CoreAudio returned an invalid audio object list".into());
    }
    let mut objects = vec![0u32; size as usize / size_of::<u32>()];
    check(unsafe {
        AudioObjectGetPropertyData(
            object, &address, 0, ptr::null(), &mut size, objects.as_mut_ptr().cast(),
        )
    }, "Reading audio object list")?;
    objects.truncate(size as usize / size_of::<u32>());
    Ok(objects)
}

fn string_property(object: AudioObjectID, selector: u32) -> Result<CFString, String> {
    let value: CFStringRef = property(object, selector, kAudioObjectPropertyScopeGlobal)?;
    if value.is_null() {
        return Err("CoreAudio returned an empty device identifier".into());
    }
    Ok(unsafe { CFString::wrap_under_create_rule(value) })
}

fn output_device(name: Option<&str>) -> Result<AudioObjectID, String> {
    if let Some(name) = name {
        for device in object_list(
            kAudioObjectSystemObject, kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal,
        )? {
            if !object_list(device, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput)?.is_empty()
                && string_property(device, kAudioObjectPropertyName)?.to_string() == name
            {
                return Ok(device);
            }
        }
        Err(format!("Output device '{name}' not found"))
    } else {
        let device = property(
            kAudioObjectSystemObject, kAudioHardwarePropertyDefaultOutputDevice,
            kAudioObjectPropertyScopeGlobal,
        )?;
        if device == kAudioObjectUnknown {
            Err("No default output device".into())
        } else {
            Ok(device)
        }
    }
}

struct Capture {
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    io_proc: AudioDeviceIOProcID,
    destroy_tap: DestroyTap,
    queue: Option<Box<CaptureQueue>>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            if self.io_proc.is_some() {
                let status = AudioDeviceStop(self.aggregate, self.io_proc);
                if status != 0 {
                    log::warn!("Stopping system audio IO failed: {status}");
                }
                let status = AudioDeviceDestroyIOProcID(self.aggregate, self.io_proc);
                if status != 0 {
                    log::warn!("Destroying system audio IOProc failed: {status}");
                    if let Some(queue) = self.queue.take() {
                        log::warn!("Retaining callback storage because CoreAudio did not unregister its IOProc");
                        Box::leak(queue);
                    }
                }
            }
            if self.aggregate != kAudioObjectUnknown {
                let status = AudioHardwareDestroyAggregateDevice(self.aggregate);
                if status != 0 {
                    log::warn!("Destroying system audio aggregate failed: {status}");
                }
            }
            if self.tap != kAudioObjectUnknown {
                let status = (self.destroy_tap)(self.tap);
                if status != 0 {
                    log::warn!("Destroying system audio tap failed: {status}");
                }
            }
        }
    }
}

fn run(
    tx: mpsc::Sender<AudioChunk>,
    stop: Arc<AtomicBool>,
    name: Option<String>,
    ready: &sync_mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let create = unsafe {
        dlsym((-2isize) as *mut c_void, c"AudioHardwareCreateProcessTap".as_ptr())
    };
    let destroy = unsafe {
        dlsym((-2isize) as *mut c_void, c"AudioHardwareDestroyProcessTap".as_ptr())
    };
    if create.is_null() || destroy.is_null() {
        return Err("System audio capture requires macOS 14.2 or later".into());
    }
    let create: CreateTap = unsafe { std::mem::transmute(create) };
    let destroy_tap: DestroyTap = unsafe { std::mem::transmute(destroy) };
    let class = AnyClass::get(c"CATapDescription")
        .ok_or("System audio capture requires macOS 14.2 or later")?;
    let device = output_device(name.as_deref())?;
    let uid = string_property(device, kAudioDevicePropertyDeviceUID)?;
    let processes = CFArray::<CFNumber>::from_CFTypes(&[]);
    let description: Retained<AnyObject> = unsafe {
        let allocated: *mut AnyObject = msg_send![class, alloc];
        let initialized: *mut AnyObject = msg_send![
            allocated,
            initExcludingProcesses: processes.as_concrete_TypeRef().cast::<AnyObject>(),
            andDeviceUID: uid.as_concrete_TypeRef().cast::<AnyObject>(),
            withStream: 0isize
        ];
        Retained::from_raw(initialized).ok_or("Failed to initialize output audio tap")?
    };
    unsafe {
        let _: () = msg_send![&*description, setPrivate: Bool::YES];
        let _: () = msg_send![&*description, setMuteBehavior: 0isize];
    }
    let mut capture = Capture {
        tap: kAudioObjectUnknown,
        aggregate: kAudioObjectUnknown,
        io_proc: None,
        destroy_tap,
        queue: None,
    };
    check(unsafe {
        create(Retained::as_ptr(&description).cast_mut(), &mut capture.tap)
    }, "Creating selected-output audio tap")?;
    let format: AudioStreamBasicDescription = property(
        capture.tap, kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal,
    )?;
    let pcm_format = PcmFormat::new(&format)?;
    let tap_uid = string_property(capture.tap, kAudioTapPropertyUID)?;
    let tap = CFDictionary::from_CFType_pairs(&[
        (CFString::new("uid"), tap_uid.as_CFType()),
        (CFString::new("drift"), CFNumber::from(1i32).as_CFType()),
    ]);
    let description = CFDictionary::from_CFType_pairs(&[
        (CFString::new("name"), CFString::new("NexQ Output Capture").as_CFType()),
        (CFString::new("uid"), CFString::new(&uuid::Uuid::new_v4().to_string()).as_CFType()),
        (CFString::new("private"), CFNumber::from(1i32).as_CFType()),
        (CFString::new("tapautostart"), CFNumber::from(0i32).as_CFType()),
        (CFString::new("taps"), CFArray::from_CFTypes(&[tap]).as_CFType()),
    ]);
    check(unsafe {
        AudioHardwareCreateAggregateDevice(description.as_concrete_TypeRef().cast(), &mut capture.aggregate)
    }, "Creating private output-tap aggregate")?;
    let frames: u32 = property(
        capture.aggregate, kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal,
    )?;
    capture.queue = Some(Box::new(CaptureQueue::new(
        frames.max(4096) as usize * format.mChannelsPerFrame as usize * pcm_format.bytes,
        format.mChannelsPerFrame,
        pcm_format.bytes,
    )));
    let queue = capture.queue.as_deref_mut().unwrap();
    check(unsafe {
        AudioDeviceCreateIOProcID(
            capture.aggregate, Some(io_callback), (queue as *mut CaptureQueue).cast(),
            &mut capture.io_proc,
        )
    }, "Creating output-tap IOProc")?;
    if stop.load(Ordering::Relaxed) {
        return Err("System audio capture cancelled".into());
    }
    check(unsafe {
        AudioDeviceStart(capture.aggregate, capture.io_proc)
    }, "Starting output-tap recording")?;
    let queue = capture.queue.as_deref().unwrap();
    if queue.invalid.load(Ordering::Acquire) {
        return Err("CoreAudio returned an unsupported output-tap buffer layout".into());
    }
    ready.send(Ok(())).map_err(|_| "System audio capture startup cancelled")?;
    log::info!(
        "System output tap ACTIVE on '{}' (UID {}, stream 0): {}Hz, {}ch",
        name.as_deref().unwrap_or("default"), uid, format.mSampleRate, format.mChannelsPerFrame,
    );
    let mut mono = Vec::with_capacity(frames.max(4096) as usize);
    while !stop.load(Ordering::Relaxed) && !tx.is_closed() {
        if queue.invalid.load(Ordering::Acquire) {
            return Err("CoreAudio output-tap buffer layout changed or exceeded capacity".into());
        }
        let read = queue.read.load(Ordering::Relaxed);
        if read == queue.write.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        downmix(unsafe { &*queue.blocks[read].get() }, &pcm_format, &mut mono);
        queue.read.store((read + 1) % queue.blocks.len(), Ordering::Release);
        super::send_system_chunk(&mono, format.mSampleRate as u32, 1, &tx);
    }
    Ok(())
}

struct PcmFormat {
    bytes: usize,
    bits: u32,
    float: bool,
    signed: bool,
    big_endian: bool,
    aligned_high: bool,
}

impl PcmFormat {
    fn new(format: &AudioStreamBasicDescription) -> Result<Self, String> {
        let channels = if format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 {
            1
        } else {
            format.mChannelsPerFrame
        };
        let bytes = format.mBytesPerFrame.checked_div(channels).unwrap_or(0) as usize;
        let float = format.mFormatFlags & kAudioFormatFlagIsFloat != 0;
        if format.mFormatID != kAudioFormatLinearPCM
            || format.mChannelsPerFrame == 0 || format.mChannelsPerFrame > 32
            || !format.mSampleRate.is_finite() || format.mSampleRate < 1.0
            || format.mSampleRate > u32::MAX as f64
            || bytes == 0 || format.mBytesPerFrame as usize != bytes * channels as usize
            || if float {
                !matches!((bytes, format.mBitsPerChannel), (4, 32) | (8, 64))
            } else {
                bytes > 4 || format.mBitsPerChannel == 0
                    || format.mBitsPerChannel > bytes as u32 * 8
            }
        {
            return Err(format!("Unsupported output tap PCM format: {format:?}"));
        }
        Ok(Self {
            bytes,
            bits: format.mBitsPerChannel,
            float,
            signed: format.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0,
            big_endian: format.mFormatFlags & kAudioFormatFlagIsBigEndian != 0,
            aligned_high: format.mFormatFlags & kAudioFormatFlagIsAlignedHigh != 0,
        })
    }

    fn sample(&self, data: &[u8]) -> f64 {
        if self.float {
            return if self.bytes == 4 {
                let bytes = data.try_into().unwrap();
                if self.big_endian { f32::from_be_bytes(bytes) as f64 }
                else { f32::from_le_bytes(bytes) as f64 }
            } else {
                let bytes = data.try_into().unwrap();
                if self.big_endian { f64::from_be_bytes(bytes) }
                else { f64::from_le_bytes(bytes) }
            };
        }
        let mut bytes = [0u8; 4];
        let mut raw = if self.big_endian {
            bytes[4 - self.bytes..].copy_from_slice(data);
            u32::from_be_bytes(bytes)
        } else {
            bytes[..self.bytes].copy_from_slice(data);
            u32::from_le_bytes(bytes)
        };
        if self.aligned_high {
            raw >>= self.bytes as u32 * 8 - self.bits;
        }
        let shift = 32 - self.bits;
        let midpoint = (1u64 << (self.bits - 1)) as f64;
        if self.signed {
            ((raw << shift) as i32 >> shift) as f64 / midpoint
        } else {
            (raw & (u32::MAX >> shift)) as f64 / midpoint - 1.0
        }
    }
}

struct CapturedBlock {
    samples: Box<[u8]>,
    buffers: usize,
    lengths: [usize; 32],
    channels: [u32; 32],
    silent: [bool; 32],
}

impl CapturedBlock {
    fn new(samples: usize) -> Self {
        Self {
            samples: vec![0; samples].into_boxed_slice(),
            buffers: 0,
            lengths: [0; 32],
            channels: [0; 32],
            silent: [false; 32],
        }
    }
}

struct CaptureQueue {
    blocks: Box<[UnsafeCell<CapturedBlock>]>,
    read: AtomicUsize,
    write: AtomicUsize,
    invalid: AtomicBool,
    channels: u32,
    sample_bytes: usize,
}

impl CaptureQueue {
    fn new(samples: usize, channels: u32, sample_bytes: usize) -> Self {
        Self {
            blocks: (0..8).map(|_| UnsafeCell::new(CapturedBlock::new(samples))).collect(),
            read: AtomicUsize::new(0),
            write: AtomicUsize::new(0),
            invalid: AtomicBool::new(false),
            channels,
            sample_bytes,
        }
    }
}

unsafe extern "C" fn io_callback(
    _device: AudioObjectID,
    _now: *const AudioTimeStamp,
    input: *const AudioBufferList,
    _input_time: *const AudioTimeStamp,
    _output: *mut AudioBufferList,
    _output_time: *const AudioTimeStamp,
    context: *mut c_void,
) -> OSStatus {
    let queue = &*context.cast::<CaptureQueue>();
    if input.is_null() {
        return 0;
    }
    let count = (*input).mNumberBuffers as usize;
    if count == 0 {
        return 0;
    }
    if count > 32 {
        queue.invalid.store(true, Ordering::Release);
        return 0;
    }
    let write = queue.write.load(Ordering::Relaxed);
    let next = (write + 1) % queue.blocks.len();
    if next == queue.read.load(Ordering::Acquire) {
        return 0;
    }
    let block = &mut *queue.blocks[write].get();
    let buffers = std::slice::from_raw_parts(ptr::addr_of!((*input).mBuffers).cast::<AudioBuffer>(), count);
    let mut offset = 0;
    let mut channels = 0;
    let mut frames = None;
    for (index, buffer) in buffers.iter().enumerate() {
        let length = buffer.mDataByteSize as usize;
        let ch = buffer.mNumberChannels as usize;
        if ch == 0 || ch > queue.channels as usize
            || length % (ch * queue.sample_bytes) != 0
            || offset + length > block.samples.len()
            || frames.is_some_and(|frames| frames != length / (ch * queue.sample_bytes))
        {
            queue.invalid.store(true, Ordering::Release);
            return 0;
        }
        frames = Some(length / (ch * queue.sample_bytes));
        block.silent[index] = buffer.mData.is_null();
        if !buffer.mData.is_null() {
            ptr::copy_nonoverlapping(buffer.mData.cast::<u8>(), block.samples.as_mut_ptr().add(offset), length);
        }
        block.lengths[index] = length;
        block.channels[index] = buffer.mNumberChannels;
        channels += buffer.mNumberChannels;
        offset += length;
    }
    if channels != queue.channels {
        queue.invalid.store(true, Ordering::Release);
        return 0;
    }
    block.buffers = count;
    queue.write.store(next, Ordering::Release);
    0
}

fn downmix(block: &CapturedBlock, format: &PcmFormat, mono: &mut Vec<i16>) {
    mono.clear();
    let frames = block.lengths[0] / (block.channels[0] as usize * format.bytes);
    let channels: u32 = block.channels[..block.buffers].iter().sum();
    for frame in 0..frames {
        let mut offset = 0;
        let mut sum = 0.0f64;
        for buffer in 0..block.buffers {
            let ch = block.channels[buffer] as usize;
            for channel in 0..ch {
                if !block.silent[buffer] {
                    let start = offset + (frame * ch + channel) * format.bytes;
                    sum += format.sample(&block.samples[start..start + format.bytes]);
                }
            }
            offset += block.lengths[buffer];
        }
        let sample = sum / channels as f64;
        mono.push(if sample.is_finite() {
            (sample.clamp(-1.0, 1.0) * i16::MAX as f64) as i16
        } else {
            0
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmixes_interleaved_and_planar_output_without_clipping_or_nan() {
        let format = PcmFormat {
            bytes: 4, bits: 32, float: true, signed: false,
            big_endian: false, aligned_high: false,
        };
        let mut block = CapturedBlock::new(32);
        block.samples.copy_from_slice(&[1.0f32, -1.0, 0.5, 0.5, 2.0, 2.0, f32::NAN, 0.0]
            .into_iter().flat_map(f32::to_le_bytes).collect::<Vec<_>>());
        block.buffers = 1;
        block.lengths[0] = 32;
        block.channels[0] = 2;
        let mut mono = Vec::new();
        downmix(&block, &format, &mut mono);
        assert_eq!(mono, [0, 16383, 32767, 0]);

        block.samples.copy_from_slice(&[1.0f32, 0.5, 2.0, f32::NAN, -1.0, 0.5, 2.0, 0.0]
            .into_iter().flat_map(f32::to_le_bytes).collect::<Vec<_>>());
        block.buffers = 2;
        block.lengths[..2].copy_from_slice(&[16, 16]);
        block.channels[..2].copy_from_slice(&[1, 1]);
        downmix(&block, &format, &mut mono);
        assert_eq!(mono, [0, 16383, 32767, 0]);
    }

    #[test]
    fn decodes_signed_padded_and_unsigned_pcm_without_losing_sign() {
        let mut format = PcmFormat {
            bytes: 2, bits: 16, float: false, signed: true,
            big_endian: false, aligned_high: false,
        };
        assert_eq!(format.sample(&[0x00, 0x80]), -1.0);
        assert_eq!(format.sample(&[0x00, 0x40]), 0.5);
        format.bytes = 4;
        format.bits = 24;
        format.aligned_high = true;
        assert_eq!(format.sample(&[0x00, 0x00, 0x00, 0x80]), -1.0);
        assert_eq!(format.sample(&[0x00, 0x00, 0x00, 0x40]), 0.5);
        format.big_endian = true;
        assert_eq!(format.sample(&[0x80, 0x00, 0x00, 0x00]), -1.0);
        format.bytes = 1;
        format.bits = 8;
        format.signed = false;
        format.aligned_high = false;
        assert_eq!(format.sample(&[0]), -1.0);
        assert_eq!(format.sample(&[128]), 0.0);
    }
}
