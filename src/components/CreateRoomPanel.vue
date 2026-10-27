<script setup>
import { ref, watch } from "vue";
import {
  loadCreateRoomSettings,
  saveCreateRoomSettings,
} from "../storage.js";

const emit = defineEmits(["cancel", "submit"]);
const saved = loadCreateRoomSettings();
const games = [
  { id: "xiangqi", name: "中国象棋" },
  { id: "gomoku", name: "五子棋" },
];
const totalTimeOptions = [
  { value: 0, label: "不限" },
  { value: 10, label: "10 分钟" },
  { value: 20, label: "20 分钟" },
  { value: 30, label: "30 分钟" },
  { value: 60, label: "60 分钟" },
];
const moveTimeOptions = [
  { value: 0, label: "不限" },
  { value: 15, label: "15 秒" },
  { value: 30, label: "30 秒" },
  { value: 60, label: "60 秒" },
];

const game = ref(saved.game);
const seat = ref(saved.seat);
const minutes = ref(saved.minutes);
const moveSeconds = ref(saved.moveSeconds);
const scoring = ref(saved.scoring);
const passwordEnabled = ref(saved.passwordEnabled);
const password = ref("");
const showPassword = ref(false);
const validationError = ref("");

function sideName(value) {
  if (game.value === "xiangqi") return value === 0 ? "红方 · 先手" : "黑方 · 后手";
  return value === 0 ? "黑棋 · 先手" : "白棋 · 后手";
}

watch([game, seat, passwordEnabled, minutes, moveSeconds, scoring], () => {
  saveCreateRoomSettings({
    game: game.value,
    seat: seat.value,
    minutes: minutes.value,
    moveSeconds: moveSeconds.value,
    scoring: scoring.value,
    passwordEnabled: passwordEnabled.value,
  });
});

function submit() {
  const roomPassword = password.value.trim();
  if (passwordEnabled.value && !roomPassword) {
    validationError.value = "请输入房间密码，或切换为公开房间";
    return;
  }
  validationError.value = "";
  emit("submit", {
    game: game.value,
    seat: seat.value,
    minutes: minutes.value,
    moveSeconds: moveSeconds.value,
    scoring: scoring.value,
    password: roomPassword,
  });
}
</script>

<template>
  <section class="lobby-view lobby-form-card">
    <header class="lobby-form-heading">
      <button
        type="button"
        class="lobby-form-back"
        aria-label="返回房间列表"
        title="返回房间列表"
        @click="emit('cancel')"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M19 12H5m6-6-6 6 6 6" />
        </svg>
      </button>
      <span class="lobby-kicker">新开一席</span>
      <h2>创建房间</h2>
      <p>制定规则，邀请朋友入座。</p>
    </header>

    <div class="lobby-form-grid">
      <div class="field">
        <span>玩法</span>
        <div class="side-pick game-pick">
          <button
            v-for="item in games"
            :key="item.id"
            type="button"
            class="time-option"
            :class="{ on: game === item.id }"
            :aria-pressed="game === item.id"
            @click="game = item.id"
          >
            <span>{{ item.name }}</span>
            <svg v-if="game === item.id" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
              <path d="m5 10.5 3.2 3.2L15 6.8" />
            </svg>
          </button>
        </div>
      </div>

      <div class="field">
        <span>执方</span>
        <div class="side-pick">
          <button
            v-for="value in [0, 1]"
            :key="value"
            type="button"
            class="time-option"
            :class="{ on: seat === value }"
            :aria-pressed="seat === value"
            @click="seat = value"
          >
            <span>{{ sideName(value) }}</span>
            <svg v-if="seat === value" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
              <path d="m5 10.5 3.2 3.2L15 6.8" />
            </svg>
          </button>
        </div>
      </div>

      <div class="field">
        <span>访问方式</span>
        <div class="password-row" :class="{ enabled: passwordEnabled }">
          <div class="password-options">
            <button
              type="button"
              class="time-option"
              :class="{ on: !passwordEnabled }"
              :aria-pressed="!passwordEnabled"
              @click="passwordEnabled = false; validationError = ''"
            >
              公开房间
              <svg v-if="!passwordEnabled" aria-hidden="true" viewBox="0 0 20 20">
                <path d="m5 10.5 3.2 3.2L15 6.8" />
              </svg>
            </button>
            <button
              type="button"
              class="time-option"
              :class="{ on: passwordEnabled }"
              :aria-pressed="passwordEnabled"
              @click="passwordEnabled = true"
            >
              密码房
              <svg v-if="passwordEnabled" aria-hidden="true" viewBox="0 0 20 20">
                <path d="m5 10.5 3.2 3.2L15 6.8" />
              </svg>
            </button>
          </div>
          <div v-if="passwordEnabled" class="password-control">
            <input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              maxlength="32"
              autocomplete="new-password"
              placeholder="输入房间密码"
              @input="validationError = ''"
            />
            <button
              type="button"
              class="password-reveal"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              @click="showPassword = !showPassword"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20">
                <path d="M2.5 10s2.8-4.5 7.5-4.5 7.5 4.5 7.5 4.5-2.8 4.5-7.5 4.5S2.5 10 2.5 10z" />
                <circle cx="10" cy="10" r="2.2" />
                <path v-if="!showPassword" d="m4 4 12 12" />
              </svg>
            </button>
          </div>
          <p v-if="validationError" class="error" role="alert">{{ validationError }}</p>
        </div>
      </div>

      <div class="field">
        <span>总时间</span>
        <div class="time-options">
          <button
            v-for="option in totalTimeOptions"
            :key="option.value"
            type="button"
            class="time-option"
            :class="{ on: minutes === option.value }"
            :aria-pressed="minutes === option.value"
            @click="minutes = option.value"
          >
            {{ option.label }}
            <svg v-if="minutes === option.value" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
              <path d="m5 10.5 3.2 3.2L15 6.8" />
            </svg>
          </button>
        </div>
      </div>

      <div class="field">
        <span>计分</span>
        <div class="time-options">
          <button
            type="button"
            class="time-option"
            :class="{ on: scoring }"
            :aria-pressed="scoring"
            @click="scoring = true"
          >
            计分
            <svg v-if="scoring" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
              <path d="m5 10.5 3.2 3.2L15 6.8" />
            </svg>
          </button>
          <button
            type="button"
            class="time-option"
            :class="{ on: !scoring }"
            :aria-pressed="!scoring"
            @click="scoring = false"
          >
            不计分
            <svg v-if="!scoring" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
              <path d="m5 10.5 3.2 3.2L15 6.8" />
            </svg>
          </button>
        </div>
      </div>

      <div class="field">
        <span>每步限时</span>
        <div class="time-options">
          <button
            v-for="option in moveTimeOptions"
            :key="option.value"
            type="button"
            class="time-option"
            :class="{ on: moveSeconds === option.value }"
            :aria-pressed="moveSeconds === option.value"
            @click="moveSeconds = option.value"
          >
            {{ option.label }}
            <svg v-if="moveSeconds === option.value" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
              <path d="m5 10.5 3.2 3.2L15 6.8" />
            </svg>
          </button>
        </div>
      </div>
    </div>
    <button class="primary lobby-create" @click="submit">创建并进入</button>
  </section>
</template>
