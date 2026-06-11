# Исправление языка STT

## Цель

Сделать так, чтобы язык STT, выбранный в Settings, сохранялся в конфиге приложения и затем передавался в backend live STT. Не рефакторить несвязанный код RAG, LLM, audio capture или UI-дизайн.

## Что найдено сейчас

1. `src/settings/STTSettings.tsx` хранит язык STT только в локальном React state через `useState("en-US")`.
2. Выпадающий список языка вызывает только `setLanguage(e.target.value)`.
3. В `src/stores/configStore.ts` нет сохраняемого поля `sttLanguage`.
4. В `src/lib/ipc.ts` нет IPC-обёртки `setSTTLanguage`.
5. Rust `STTRouter` по умолчанию использует `en-US`.
6. STT-провайдеры live meeting читают язык из `STTRouter.language` через `get_stt_language()`.
7. Deepgram отправляет этот язык в WebSocket URL.
8. В коде Parakeet TDT раньше заявлял поддержку только `en`, но официальная карточка `nvidia/parakeet-tdt-0.6b-v3` говорит, что v3 поддерживает 25 языков, включая Russian (`ru`). При этом локальная Parakeet CTC 110M модель выглядит English-only (`...110m-en...`), поэтому нужен warning именно для неё.

## Последовательный план фикса

### 1. Сохранить STT language в Zustand

Файл: `src/stores/configStore.ts`

- Добавить `sttLanguage: string` в `ConfigState`.
- Добавить значение по умолчанию `sttLanguage: "en-US"`.
- Добавить action `setSTTLanguage: (language: string) => void`.
- Реализовать `setSTTLanguage` так:
  - `set({ sttLanguage: language })`
  - `persistValue("sttLanguage", language)`
- В `loadConfig()` прочитать `const sttLanguage = await store.get<string>("sttLanguage")`.
- Добавить сохранённый `sttLanguage` в основной блок загрузки `set((state) => ({ ... }))`.
- Добавить `store.onKeyChange<string>("sttLanguage", ...)` для синхронизации между окнами.

### 2. Подключить STTSettings к сохранённому state

Файл: `src/settings/STTSettings.tsx`

- Заменить локальный `useState("en-US")` для языка на:
  - `const sttLanguage = useConfigStore((s) => s.sttLanguage)`
  - `const setSTTLanguage = useConfigStore((s) => s.setSTTLanguage)`
- Поставить dropdown `value={sttLanguage}`.
- Поставить dropdown `onChange={(e) => setSTTLanguage(e.target.value)}`.

### 3. Добавить frontend IPC wrapper

Файл: `src/lib/ipc.ts`

- Добавить `setSTTLanguage(language: string): Promise<void>`.
- Вызывать Rust command через `invoke("set_stt_language", { language })`.

### 4. Добавить Rust Tauri command

Файл: `src-tauri/src/commands/stt_commands.rs`

- Добавить `set_stt_language(app: AppHandle, language: String) -> Result<(), String>`.
- Убедиться, что STT router существует.
- Залочить router и вызвать `router.set_language(&language)`.
- Залогировать обновлённый язык.

### 5. Зарегистрировать Rust command

Файл: `src-tauri/src/lib.rs`

- Добавить `stt_commands::set_stt_language` в `tauri::generate_handler![...]`.

### 6. Синхронизировать сохранённый язык с backend при старте

Файл: `src/stores/configStore.ts`

- После загрузки config вызвать новый IPC wrapper со значением `sttLanguage ?? "en-US"`.
- Использовать тот же startup sync pattern, который уже применяется для Deepgram, Groq и pause threshold.

### 7. Исправить hardcoded language в Web Speech

Файл: `src/hooks/useSpeechRecognition.ts`

- Заменить hardcoded `recognition.lang = "en-US"` и `fresh.lang = "en-US"` на сохранённое значение из store.
- Оставить изменение строго в рамках Web Speech.

### 8. Уточнить возможности Parakeet

Файл: `src/settings/STTSettings.tsx` или обработка provider metadata

- Не делать вид, что весь Parakeet TDT English-only: `parakeet-tdt-0.6b-v3` поддерживает русский (`ru`).
- Не делать вид, что Parakeet CTC 110M поддерживает русский: эта модель English-only.
- Добавить небольшой provider-specific warning для Parakeet CTC 110M, если выбран неанглийский STT language.
- Обновить backend provider metadata для Parakeet TDT v3: добавить поддерживаемые языки v3, включая `ru`.
- Держать изменение узким и не переделывать settings UI.

## Проверка

1. Выбрать Russian в Settings -> STT -> Language.
2. Перезапустить приложение.
3. Снова открыть Settings -> STT и проверить, что Russian всё ещё выбран.
4. Запустить live meeting с Deepgram и проверить в логах `language=ru-RU` или эквивалентное обновление языка в backend.
5. Запустить live meeting с Web Speech и проверить, что `recognition.lang` использует сохранённое значение.
6. С Parakeet TDT проверить, что приложение предупреждает или блокирует неподдерживаемый русский, а не молча ведёт себя как English-only модель.
7. Для Deepgram проверить, что UI locale `ru-RU` нормализуется в backend language code `ru`.
