//! Ending a child together with everything it started.
//!
//! `Child::kill` ends only the direct child. An MCP server started through
//! `cmd /c npx ...` or `uvx` leaves a grandchild that keeps running (and keeps
//! the stderr pipe open). On Windows the child goes into a job object that
//! kills every process in it when the handle closes.

use std::process::Child;

/// Owns the processes of one child: dropping it ends all of them.
pub struct ProcessTree {
    #[cfg(windows)]
    job: Option<windows::Win32::Foundation::HANDLE>,
}

// The job handle is only closed on drop.
#[cfg(windows)]
unsafe impl Send for ProcessTree {}

impl ProcessTree {
    /// Put `child` (just spawned) into a kill-on-close job. If that fails the
    /// tree falls back to ending the direct child only.
    #[cfg(windows)]
    pub fn adopt(child: &Child) -> Self {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let Ok(job) = CreateJobObjectW(None, windows::core::PCWSTR::null()) else {
                return Self { job: None };
            };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let assigned = set.is_ok()
                && AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())).is_ok();
            if assigned {
                Self { job: Some(job) }
            } else {
                let _ = CloseHandle(job);
                Self { job: None }
            }
        }
    }

    #[cfg(not(windows))]
    pub fn adopt(_child: &Child) -> Self {
        Self {}
    }

    /// End `child` and every process it started, then reap it.
    pub fn kill(self, child: &mut Child) {
        let _ = child.kill();
        drop(self); // closes the job: ends the grandchildren
        let _ = child.wait();
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        if let Some(job) = self.job.take() {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(job);
            }
        }
    }
}
