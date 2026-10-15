<script lang="ts">
  import PanelTitle from "./PanelTitle.svelte";

  type AnyRecord = Record<string, any>;
  let { fields }: { fields: ReadonlyArray<AnyRecord> } = $props();
</script>

<article
  class="min-w-0 rounded-2xl border border-white/10 bg-[#09101a]/90 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.24)] sm:p-5"
>
  <PanelTitle kicker="responses" title="What comes back" />
  <p class="mt-2 text-sm leading-relaxed text-slate-400">
    Consumer apps should read these bridge-specific response fields instead of
    guessing from local filesystem paths.
  </p>
  <div class="mt-4 grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
    {#each fields as field (field.name)}
      <div class="min-w-0 rounded-xl border border-white/10 bg-black/25 p-4">
        <code
          class="inline-block max-w-full break-all rounded-lg bg-black/50 px-2 py-1 text-xs font-black text-cyan-100"
          >{field.name}</code
        >
        <div
          class="mt-3 break-words text-[11px] font-black uppercase tracking-[0.16em] text-slate-500"
        >
          {field.where}
        </div>
        <p class="mt-2 break-words text-sm text-slate-300">{field.meaning}</p>
      </div>
    {/each}
  </div>
</article>
