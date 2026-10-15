<script lang="ts">
  import Badge from "./Badge.svelte";

  type AnyRecord = Record<string, any>;
  type Account = AnyRecord & { live?: AnyRecord };

  let {
    accounts = [],
    compact = false,
    oncheck,
    ondelete,
    onedit,
    featureText,
  }: {
    accounts: Account[];
    compact?: boolean;
    oncheck: (name: string) => void;
    ondelete: (name: string) => void;
    onedit?: (name: string) => void;
    featureText: (feature: AnyRecord | undefined) => string;
  } = $props();
</script>

<div class="grid gap-3">
  {#each accounts as account (account.account)}
    <article
      class="grid gap-3 rounded-3xl border border-white/10 bg-white/[0.03] p-4 xl:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-xl font-black">{account.account}</h3>
          <Badge tone={account.live?.ok ? "ok" : account.live ? "bad" : "warn"}>
            {account.live?.ok
              ? "live ok"
              : account.live
                ? "live error"
                : "not checked"}
          </Badge>
          <Badge
            >{account.live?.plan_type ||
              account.plan_type ||
              account.plan_bucket ||
              "plan unknown"}</Badge
          >
        </div>
        <div class="mt-1 break-all font-mono text-xs text-slate-500">
          {account.capture_path || "no capture path"}
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <Badge tone={account.configured ? "ok" : "neutral"}
            >{account.configured ? "configured" : "not routed"}</Badge
          >
          <Badge tone={account.capture_exists ? "ok" : "bad"}
            >{account.capture_exists ? "capture yes" : "capture no"}</Badge
          >
          <Badge tone={account.settings_exists ? "ok" : "warn"}
            >{account.settings_exists ? "settings yes" : "settings no"}</Badge
          >
          <Badge>default {account.live?.default_model_slug || "-"}</Badge>
        </div>
        {#if account.live?.features && !compact}
          <div class="mt-3 grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
            <div>
              Research: {featureText(account.live.features.deep_research)}
            </div>
            <div>Image: {featureText(account.live.features.image_gen)}</div>
            <div>
              File upload: {featureText(account.live.features.file_upload)}
            </div>
            <div>
              Paste file: {featureText(
                account.live.features.paste_text_to_file,
              )}
            </div>
          </div>
        {/if}
        {#if account.live?.error || account.profile_error}
          <div
            class="mt-3 rounded-2xl border border-rose-300/30 bg-rose-300/10 p-3 text-sm text-rose-100"
          >
            {account.live?.error || account.profile_error}
          </div>
        {/if}
      </div>
      <div class="flex flex-wrap items-start gap-2 xl:justify-end">
        <button
          class="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold"
          onclick={() => oncheck(account.account)}
        >
          Check
        </button>
        {#if onedit}
          <button
            class="rounded-2xl border border-sky-300/30 bg-sky-300/10 px-3 py-2 text-sm font-bold text-sky-100"
            onclick={() => onedit(account.account)}
          >
            Update capture
          </button>
        {/if}
        <button
          class="rounded-2xl border border-rose-300/40 bg-rose-300/10 px-3 py-2 text-sm font-bold text-rose-100"
          onclick={() => ondelete(account.account)}
        >
          Delete
        </button>
      </div>
    </article>
  {:else}
    <div
      class="rounded-3xl border border-white/10 bg-white/[0.03] p-8 text-slate-400"
    >
      No accounts found.
    </div>
  {/each}
</div>
