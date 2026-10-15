<script lang="ts">
  type AnyRecord = Record<string, any>;
  let {
    result,
    downloadUrl,
  }: {
    result: AnyRecord | null;
    downloadUrl: (url: string) => string;
  } = $props();
</script>

<div class="mt-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4">
  {#if !result}
    <div class="text-sm text-slate-400">Generated image appears here.</div>
  {:else if result.data?.[0]?.download_url || result.data?.[0]?.url}
    {@const item = result.data[0]}
    <a
      href={downloadUrl(item.download_url || item.url)}
      target="_blank"
      rel="noreferrer"
    >
      <img
        class="max-h-[520px] w-full rounded-2xl bg-slate-950 object-contain"
        src={downloadUrl(item.download_url || item.url)}
        alt="Generated result"
      />
    </a>
    <div class="mt-2 break-all font-mono text-xs text-slate-500">
      {item.path || item.download_url || item.url}
    </div>
  {:else}
    <pre class="text-sm text-slate-300">{JSON.stringify(result, null, 2)}</pre>
  {/if}
</div>
