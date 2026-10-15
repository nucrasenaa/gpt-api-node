<script lang="ts">
  let { kicker, title }: { kicker: string; title: string } = $props();
</script>

<div class="mb-4 border-l-2 border-cyan-300/70 pl-3">
  <p class="text-[11px] font-black uppercase tracking-[0.22em] text-cyan-200/90">
    {kicker}
  </p>
  <h2 class="mt-1 text-2xl font-black tracking-[-0.045em] text-white">
    {title}
  </h2>
</div>
