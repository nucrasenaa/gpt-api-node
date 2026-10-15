<script lang="ts">
  let { title, code }: { title: string; code: string } = $props();
  let copied = $state(false);

  async function copyCode() {
    await navigator.clipboard.writeText(code);
    copied = true;
    window.dispatchEvent(
      new CustomEvent("chatgpt-console-toast", {
        detail: "Copied to clipboard",
      }),
    );
    window.setTimeout(() => {
      copied = false;
    }, 1600);
  }
</script>

<details
  class="mt-4 min-w-0 max-w-full overflow-hidden rounded-xl border border-cyan-300/15 bg-[#03070b]"
  open
>
  <summary
    class="cursor-pointer border-b border-white/10 bg-cyan-300/[0.04] px-4 py-3 text-sm font-black text-cyan-50"
  >
    {title}
  </summary>
  <div class="min-w-0 p-4">
    <pre
      class="max-h-[420px] max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-slate-300">{code}</pre>
    <button
      class={`mt-3 rounded-lg border px-3 py-2 text-sm font-black transition ${
        copied
          ? "border-cyan-300/40 bg-cyan-300/15 text-cyan-50"
          : "border-white/10 bg-white/[0.035] text-slate-200 hover:border-cyan-300/30 hover:bg-cyan-300/10"
      }`}
      onclick={copyCode}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  </div>
</details>
