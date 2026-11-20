<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { createQueryPoller } from './query-helpers'

const props = defineProps({
  server: { type: Object, required: true }
})

const { t } = useI18n()

const data = ref({})

let poller = null
onMounted(() => {
  poller = createQueryPoller(props.server, { onUpdate: result => { data.value = result } })
  poller.start()
})

onUnmounted(() => {
  if (poller) poller.stop()
})
</script>

<template>
  <div class="query">
    <div v-if="data.minecraft" class="minecraft">
      <span class="playerCountText">
        {{ t('servers.NumPlayersOnline', {current: data.minecraft.numPlayers, max: data.minecraft.maxPlayers}) }}
      </span>
      <progress
        class="playerCountBar"
        :value="data.minecraft.numPlayers"
        :max="data.minecraft.maxPlayers"
      />
      <div v-if="(data.minecraft.players || []).length > 0" class="players">
        <div v-for="player in data.minecraft.players || []" :key="player" v-text="player" />
      </div>
    </div>
  </div>
</template>