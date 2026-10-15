<script lang="ts">
  let {
    label,
    value = $bindable(""),
    rows = 4,
  }: {
    label: string;
    value: string;
    rows?: number;
  } = $props();
</script>

<label class="mt-4 block">
  <span class="text-xs font-black uppercase tracking-[0.14em] text-slate-400"
    >{label}</span
  >
  <textarea
    class="mt-2 w-full rounded-xl border border-white/10 bg-black/35 px-3 py-3 text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-300/60 focus:bg-cyan-300/[0.04]"
    {rows}
    bind:value></textarea>
</label>
