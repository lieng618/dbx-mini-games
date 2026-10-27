<script setup>
import { nextTick, ref, watch } from "vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  nickname: { type: String, default: "" },
  nicknameDraft: { type: String, default: "" },
  nicknameSaving: { type: Boolean, default: false },
  nicknameError: { type: String, default: "" },
  effectsEnabled: { type: Boolean, default: true },
  boardSize: { type: String, default: "standard" },
  theme: { type: String, default: "paper" },
});

const emit = defineEmits([
  "close",
  "save",
  "reset-nickname",
  "update:nicknameDraft",
  "update:effectsEnabled",
  "update:boardSize",
  "update:theme",
]);

const closeButton = ref(null);
const effectOptions = [
  { value: true, label: "开" },
  { value: false, label: "关" },
];
const boardSizeOptions = [
  { value: "compact", label: "紧凑" },
  { value: "standard", label: "标准" },
  { value: "large", label: "大" },
];
const themeOptions = [
  { value: "paper", label: "纸白" },
  { value: "ink", label: "墨色" },
];

async function focusClose() {
  await nextTick();
  closeButton.value?.focus();
}

watch(
  () => props.open,
  (open) => {
    if (open) void focusClose();
  },
);

defineExpose({ focusClose });
</script>

<template>
  <Transition name="settings-drawer">
    <div v-if="open" class="settings-layer" @click.self="emit('close')">
      <section
        id="settings-drawer"
        class="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header class="settings-drawer-head">
          <div>
            <span class="settings-kicker">个人偏好</span>
            <h2 id="settings-title">设置</h2>
          </div>
          <button
            ref="closeButton"
            type="button"
            class="settings-close"
            aria-label="关闭设置"
            @click="emit('close')"
          >
            ×
          </button>
        </header>

        <div class="settings-grid">
          <div class="setting-row setting-nickname-row">
            <span class="setting-copy">
              <strong>昵称</strong>
            </span>
            <div class="nickname-settings-control">
              <div class="nickname-settings-form">
                <input
                  :value="nicknameDraft"
                  :class="{ invalid: Boolean(nicknameError) }"
                  type="text"
                  maxlength="12"
                  autocomplete="nickname"
                  autocapitalize="off"
                  spellcheck="false"
                  aria-label="昵称"
                  :aria-invalid="Boolean(nicknameError)"
                  :aria-describedby="nicknameError ? 'nickname-settings-error' : undefined"
                  :disabled="nicknameSaving"
                  @input="emit('update:nicknameDraft', $event.target.value)"
                  @keydown.enter.prevent="emit('save')"
                  @keydown.esc.prevent.stop="emit('reset-nickname')"
                />
                <button
                  type="button"
                  class="nickname-save"
                  aria-label="保存昵称"
                  title="保存昵称"
                  :disabled="nicknameSaving || nicknameDraft.trim() === nickname"
                  @click="emit('save')"
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20">
                    <path d="m5 10.5 3.2 3.2L15 6.8" />
                  </svg>
                </button>
              </div>
              <span
                v-if="nicknameError"
                id="nickname-settings-error"
                class="nickname-settings-error"
                role="alert"
              >
                {{ nicknameError }}
              </span>
            </div>
          </div>

          <div class="setting-row setting-choice-row">
            <span><strong>动态特效</strong></span>
            <div class="time-options" role="group" aria-label="动态特效">
              <button
                v-for="option in effectOptions"
                :key="String(option.value)"
                type="button"
                class="time-option"
                :class="{ on: effectsEnabled === option.value }"
                :aria-pressed="effectsEnabled === option.value"
                @click="emit('update:effectsEnabled', option.value)"
              >
                {{ option.label }}
                <svg
                  v-if="effectsEnabled === option.value"
                  class="choice-check"
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                >
                  <path d="m5 10.5 3.2 3.2L15 6.8" />
                </svg>
              </button>
            </div>
          </div>

          <div class="setting-row setting-choice-row">
            <span><strong>棋盘大小</strong></span>
            <div class="time-options" role="group" aria-label="棋盘大小">
              <button
                v-for="option in boardSizeOptions"
                :key="option.value"
                type="button"
                class="time-option"
                :class="{ on: boardSize === option.value }"
                :aria-pressed="boardSize === option.value"
                @click="emit('update:boardSize', option.value)"
              >
                {{ option.label }}
                <svg
                  v-if="boardSize === option.value"
                  class="choice-check"
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                >
                  <path d="m5 10.5 3.2 3.2L15 6.8" />
                </svg>
              </button>
            </div>
          </div>

          <div class="setting-row setting-choice-row">
            <span><strong>主题</strong></span>
            <div class="time-options" role="group" aria-label="主题">
              <button
                v-for="option in themeOptions"
                :key="option.value"
                type="button"
                class="time-option"
                :class="{ on: theme === option.value }"
                :aria-pressed="theme === option.value"
                @click="emit('update:theme', option.value)"
              >
                {{ option.label }}
                <svg
                  v-if="theme === option.value"
                  class="choice-check"
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                >
                  <path d="m5 10.5 3.2 3.2L15 6.8" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.settings-layer {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  justify-content: flex-end;
  padding: 14px;
  background: rgba(25, 22, 18, 0.3);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}

.settings-drawer {
  width: min(440px, calc(100vw - 28px));
  max-height: calc(100dvh - 28px);
  padding: 70px 24px 24px;
  overflow-y: auto;
  color: var(--ink);
  border: 1px solid rgba(91, 70, 44, 0.26);
  border-radius: 3px 16px 3px 16px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.5), transparent 48%),
    var(--paper-warm);
  box-shadow: 10px 10px 0 rgba(31, 25, 18, 0.12), var(--shadow-3);
  overscroll-behavior: contain;
}

.settings-drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 2px 0 18px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--line);
}

.settings-kicker {
  color: var(--red-deep);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
}

.settings-drawer-head h2 {
  margin: 5px 0 0;
  font-family: var(--font-display);
  font-size: 30px;
  line-height: 1.1;
  letter-spacing: 0.08em;
}

.settings-close {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  min-width: 44px;
  padding: 0;
  color: var(--soft-text);
  border: 1px solid var(--line);
  border-radius: 50%;
  background: transparent;
  box-shadow: none;
  font-size: 26px;
  line-height: 1;
}

.settings-close:hover {
  color: var(--red-deep);
  border-color: rgba(157, 48, 38, 0.36);
  background: rgba(157, 48, 38, 0.06);
}

.settings-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 54px;
  padding: 10px 14px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card);
  background: rgba(255, 253, 248, 0.72);
}

.setting-row > span {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.setting-row strong { font-size: 14px; }
.setting-row small { color: var(--soft-text); font-size: 11px; line-height: 1.45; }

.setting-nickname-row {
  align-items: flex-start;
  gap: 24px;
}

.setting-nickname-row .setting-copy {
  flex: 1 1 auto;
  padding-top: 10px;
}

.nickname-settings-control {
  flex: 0 1 248px;
  width: 248px;
  min-width: 0;
}

.nickname-settings-form {
  display: flex;
  align-items: stretch;
}

.nickname-settings-form input {
  flex: 1;
  min-width: 0;
  height: 44px;
  padding: 0 14px;
  color: var(--ink);
  background: rgba(249, 244, 235, 0.42);
  border: 1px solid rgba(55, 43, 27, 0.25);
  border-right: 0;
  border-radius: 0;
  outline: 0;
  font: inherit;
  font-family: var(--font-num);
  font-size: 16px;
  letter-spacing: 0.02em;
}

.nickname-settings-form input:focus {
  position: relative;
  z-index: 1;
  border-color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--ink);
}

.nickname-settings-form input.invalid { border-color: var(--red); }

.nickname-save {
  display: grid;
  place-items: center;
  flex: 0 0 46px;
  width: 46px;
  height: 44px;
  padding: 0;
  color: #fffaf0;
  background: var(--ink);
  border: 1px solid var(--ink);
  border-radius: 0;
  box-shadow: none;
}

.nickname-save:disabled {
  color: var(--soft-text);
  background: rgba(249, 244, 235, 0.42);
  border-color: rgba(55, 43, 27, 0.25);
  opacity: 1;
}

.nickname-save svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.nickname-settings-error {
  display: block;
  margin-top: 7px;
  color: var(--red-deep);
  font-size: 11px;
  line-height: 1.45;
}

.settings-drawer-enter-active,
.settings-drawer-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}

.settings-drawer-enter-active .settings-drawer,
.settings-drawer-leave-active .settings-drawer {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-slow) var(--ease-standard);
}

.settings-drawer-enter-from,
.settings-drawer-leave-to {
  opacity: 0;
}

.settings-drawer-enter-from .settings-drawer,
.settings-drawer-leave-to .settings-drawer {
  opacity: 0;
  transform: translateX(24px);
}

:global([data-theme="ink"]) .settings-layer {
  background: rgba(7, 6, 5, 0.58);
}

:global([data-theme="ink"]) .settings-drawer {
  border-color: rgba(243, 234, 217, 0.22);
  background:
    linear-gradient(135deg, rgba(255, 248, 235, 0.05), transparent 48%),
    #29251f;
  box-shadow: 10px 10px 0 rgba(0, 0, 0, 0.35), var(--shadow-3);
}

:global([data-theme="ink"]) .setting-row {
  background: transparent;
}

:global([data-theme="ink"]) .nickname-settings-form input {
  color: #f3ead9;
  background: rgba(255, 248, 235, 0.055);
  border-color: rgba(243, 234, 217, 0.26);
}

:global([data-theme="ink"]) .nickname-settings-form input:focus {
  border-color: #e4d8c5;
  box-shadow: inset 0 0 0 1px #e4d8c5;
}

:global([data-theme="ink"]) .nickname-settings-form input.invalid {
  border-color: #de8072;
}

:global([data-theme="ink"]) .nickname-save {
  color: #fffaf0;
  background: #98372d;
  border-color: #d76d61;
}

:global([data-theme="ink"]) .nickname-settings-error {
  color: #ffb3a8;
}

@media (max-width: 620px) {
  .settings-layer {
    align-items: flex-end;
    padding: 0;
  }

  .settings-drawer {
    width: 100%;
    max-height: 90dvh;
    padding: 22px 16px calc(20px + env(safe-area-inset-bottom, 0px));
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -14px 48px rgba(24, 20, 15, 0.24);
  }

  .settings-drawer-enter-from .settings-drawer,
  .settings-drawer-leave-to .settings-drawer {
    transform: translateY(24px);
  }

  .setting-nickname-row {
    align-items: center;
    flex-direction: row;
    gap: 12px;
  }

  .setting-nickname-row .setting-copy {
    flex: 0 0 auto;
    padding-top: 0;
  }

  .nickname-settings-control {
    flex: 1 1 auto;
    width: auto;
  }
}
</style>
