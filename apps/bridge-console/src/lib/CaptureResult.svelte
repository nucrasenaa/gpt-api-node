<script lang="ts">
  import Badge from "./Badge.svelte";

  type AnyRecord = Record<string, any>;
  let { result }: { result: AnyRecord | null } = $props();
</script>

<div
  class="mt-4 min-w-0 rounded-3xl border border-white/10 bg-white/[0.03] p-4"
>
  {#if !result}
    <div class="text-sm text-slate-400">
      Paste a request to inspect missing headers and plan hints.
    </div>
  {:else}
    <div class="flex min-w-0 flex-wrap gap-2">
      <Badge tone={result.ok ? "ok" : "bad"}
        >{result.ok && !(result.warnings ?? []).length
          ? "all checks pass"
          : "not safe to save"}</Badge
      >
      <Badge
        >{String(
          result.detected?.plan_type ||
            result.detected?.plan_bucket ||
            "unknown plan",
        )}</Badge
      >
    </div>
    {#if (result.missing ?? []).length || (result.warnings ?? []).length}
      <div
        class="mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-3 text-sm text-amber-100"
      >
        Fix every required and recommended item before saving. Save refuses to
        write incomplete captures unless the API is explicitly called with
        force.
      </div>
    {/if}
    <div class="mt-3 grid min-w-0 gap-2">
      {#each result.checks ?? [] as check (check.name)}
        <div
          class="grid min-w-0 gap-2 rounded-2xl border border-white/10 bg-black/15 p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"
        >
          <div class="min-w-0">
            <div class="break-all font-black text-slate-200">{check.name}</div>
            <div class="mt-1 break-words text-xs text-slate-500">
              {check.detail || ""}
            </div>
          </div>
          <div class="sm:text-right">
            <Badge
              tone={check.ok
                ? "ok"
                : check.level === "required"
                  ? "bad"
                  : "warn"}
            >
              {check.ok ? "ok" : check.level}
            </Badge>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
