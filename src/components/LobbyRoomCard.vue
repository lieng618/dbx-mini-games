<script setup>
defineProps({
  room: { type: Object, required: true },
  gameLabel: { type: String, required: true },
  statusLabel: { type: String, required: true },
  durationLabel: { type: String, required: true },
});

defineEmits(["join", "spectate"]);
</script>

<template>
  <article
    class="lobby-room-card"
    :class="`status-${room.phase}`"
    :data-game="room.game"
  >
    <div class="lobby-room-top">
      <span class="game-mark">
        <span class="game-seal" aria-hidden="true">
          <svg v-if="room.game === 'xiangqi'" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8" />
            <path d="M8.5 10h7M8.5 14h7M12 7.5v9" />
          </svg>
          <svg v-else viewBox="0 0 24 24">
            <circle cx="6" cy="6" r="2" />
            <circle cx="12" cy="9" r="2" />
            <circle cx="18" cy="12" r="2" />
            <circle cx="9" cy="15" r="2" />
            <circle cx="15" cy="18" r="2" />
          </svg>
        </span>
        {{ gameLabel }}
      </span>
      <span class="room-badges">
        <span v-if="room.locked" class="lock-badge" title="需要密码">
          <svg aria-hidden="true" viewBox="0 0 16 16">
            <rect x="3.5" y="7" width="9" height="6" rx="1.5" />
            <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
          </svg>
          私房
        </span>
        <span class="room-state">{{ statusLabel }}</span>
      </span>
    </div>
    <h3>{{ room.name }}</h3>
    <div class="room-stats">
      <span><b>{{ room.players }}/{{ room.capacity }}</b> 玩家</span>
      <span v-if="room.phase === 'playing'"><b>{{ room.spectators }}</b> 观战</span>
      <span>{{ durationLabel }}</span>
    </div>
    <div class="room-actions" :class="{ 'single-action': room.phase !== 'playing' }">
      <button
        class="primary"
        :disabled="room.players >= room.capacity || room.phase === 'finished'"
        @click="$emit('join')"
      >
        {{ room.phase === "finished" ? "已结束" : room.players >= room.capacity ? "满桌" : "加入" }}
      </button>
      <button
        v-if="room.phase === 'playing'"
        class="ghost"
        :disabled="room.spectators >= room.spectatorCap"
        @click="$emit('spectate')"
      >
        观战
      </button>
    </div>
  </article>
</template>
