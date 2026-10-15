<script lang="ts">
  let { items }: { items: [string, string][] } = $props();
</script>

<div class="grid gap-3 sm:grid-cols-2">
  {#each items as [label, value]}
    <div class="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div class="text-xs text-slate-500">{label}</div>
      <div class="mt-1 break-all text-lg font-black">{value}</div>
    </div>
  {/each}
</div>
