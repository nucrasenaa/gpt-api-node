<script lang="ts">
  import Badge from "./Badge.svelte";
  import PanelTitle from "./PanelTitle.svelte";

  type AnyRecord = Record<string, any>;
  let { guides }: { guides: ReadonlyArray<AnyRecord> } = $props();
</script>

<article
  class="min-w-0 rounded-2xl border border-cyan-300/20 bg-[#071018]/90 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.28)] sm:p-5"
>
  <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
    <PanelTitle kicker="field atlas" title="What every parameter means" />
    <Badge tone="ok">read before integrating</Badge>
  </div>
  <p class="mt-2 max-w-4xl text-sm leading-relaxed text-slate-400">
    These are the fields this bridge actually understands. Treat it as a
    ChatGPT-Web-backed bridge with familiar request shapes, not a perfect OpenAI
    API clone. If a field is not listed here, assume it may be ignored unless
    the route docs say otherwise.
  </p>
  <div class="mt-5 grid min-w-0 gap-4 xl:grid-cols-2">
    {#each guides as group (group.title)}
      <section class="min-w-0 rounded-2xl border border-white/10 bg-black/25 p-4">
        <div class="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div class="min-w-0">
            <h3 class="break-words text-lg font-black text-slate-50">
              {group.title}
            </h3>
            <div
              class="mt-1 break-all font-mono text-xs font-bold text-sky-200/80"
            >
              {group.route}
            </div>
          </div>
          <Badge>{group.fields.length} fields</Badge>
        </div>
        <div class="mt-4 grid min-w-0 gap-3">
          {#each group.fields as field (field.name)}
            <details
              class="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-4 open:border-cyan-300/30 open:bg-cyan-300/[0.045]"
            >
              <summary class="cursor-pointer list-none select-none">
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <code
                    class="max-w-full break-all rounded-lg bg-black/50 px-2 py-1 text-sm font-black text-cyan-100"
                    >{field.name}</code
                  >
                  <Badge>{field.type}</Badge>
                  <span class="break-words text-xs text-slate-500"
                    >default: {field.defaultValue}</span
                  >
                </div>
              </summary>
              <div class="mt-3 grid min-w-0 gap-3 text-sm">
                <div class="min-w-0">
                  <div
                    class="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500"
                  >
                    What it does
                  </div>
                  <p class="mt-1 break-words text-slate-300">
                    {field.meaning}
                  </p>
                </div>
                <div class="min-w-0">
                  <div
                    class="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500"
                  >
                    Recommended
                  </div>
                  <p class="mt-1 break-words text-slate-300">
                    {field.recommended}
                  </p>
                </div>
                <div class="min-w-0">
                  <div
                    class="text-[11px] font-black uppercase tracking-[0.16em] text-amber-200/70"
                  >
                    Watch out
                  </div>
                  <p class="mt-1 break-words text-amber-100/80">
                    {field.gotcha}
                  </p>
                </div>
              </div>
            </details>
          {/each}
        </div>
      </section>
    {/each}
  </div>
</article>
