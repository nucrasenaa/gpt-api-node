<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    tone = "neutral",
    children,
  }: {
    tone?: "neutral" | "ok" | "bad" | "warn";
    children?: Snippet;
  } = $props();

  const classes = $derived(
    tone === "ok"
      ? "border-sky-300/40 text-sky-100"
      : tone === "bad"
        ? "border-rose-300/40 text-rose-100"
        : tone === "warn"
          ? "border-amber-300/40 text-amber-100"
          : "border-white/10 text-slate-300",
  );
</script>

<span class={`rounded-full border px-3 py-1 text-xs font-bold ${classes}`}>
  {@render children?.()}
</span>
