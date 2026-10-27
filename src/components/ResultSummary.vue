<script setup>
defineProps({
  result: { type: Object, default: null },
  mvp: { type: Object, default: null },
  reducedMotion: { type: Boolean, default: false },
  role: { type: String, default: "guest" },
  outcomeLabel: { type: String, default: "" },
  reasonLabel: { type: String, default: "" },
});

defineEmits(["dismiss", "rematch"]);

const confettiColors = ["#c8a24a", "#8f2f28", "#4a6b52", "#2f2a24", "#d9c48a"];

function confettiStyle(index) {
  return {
    left: `${(index * 37) % 100}%`,
    animationDelay: `${((index * 13) % 30) / 10}s`,
    animationDuration: `${2.6 + ((index * 7) % 20) / 10}s`,
    background: confettiColors[index % confettiColors.length],
  };
}
</script>

<template>
  <div v-if="result?.finished && !mvp" class="result-banner">
    <strong>{{ outcomeLabel }}</strong>
    <span>{{ reasonLabel }}</span>
  </div>

  <div v-if="mvp && !reducedMotion" class="mvp-confetti" aria-hidden="true">
    <i v-for="n in 26" :key="n" :style="confettiStyle(n)"></i>
  </div>

  <div
    v-if="mvp"
    class="mvp"
    :class="{ calm: reducedMotion, draw: mvp.draw }"
    role="dialog"
    aria-modal="true"
    aria-labelledby="mvp-title"
    @click.self="$emit('dismiss')"
  >
    <div class="mvp-card">
      <button
        class="mvp-close"
        type="button"
        aria-label="收起结算卡"
        @click="$emit('dismiss')"
      >
        ×
      </button>
      <p class="mvp-eyebrow">本 局 最 有 价 值</p>
      <h2 id="mvp-title" class="mvp-badge">MVP</h2>
      <p class="mvp-name">{{ mvp.name }}</p>
      <p class="mvp-title">{{ mvp.title }}</p>
      <dl class="mvp-stats">
        <div v-for="stat in mvp.stats" :key="stat.label">
          <dt>{{ stat.label }}</dt>
          <dd>{{ stat.value }}</dd>
        </div>
      </dl>
      <p class="mvp-reason">{{ mvp.reason }}</p>
      <div class="mvp-actions">
        <button v-if="role === 'host'" class="primary" @click="$emit('rematch')">
          再来一局
        </button>
        <p v-else class="mvp-awaiting">等待房主开始下一局</p>
      </div>
    </div>
  </div>
</template>
