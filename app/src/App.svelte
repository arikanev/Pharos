<script lang="ts">
  import Plan from "./Plan.svelte";
  import Navigate from "./Navigate.svelte";
  import { liveAnnouncement } from "./lib/a11y";

  type Screen = "plan" | "navigate";

  let screen = $state<Screen>("plan");
  let live = $state("");

  liveAnnouncement.subscribe((m) => (live = m));
</script>

<main>
  <nav class="topbar" aria-label="Primary">
    <button type="button" class:active={screen === "plan"}
            onclick={() => (screen = "plan")}>Plan</button>
    <button type="button" class:active={screen === "navigate"}
            onclick={() => (screen = "navigate")}>Navigate</button>
  </nav>

  {#if screen === "plan"}
    <Plan onPlanned={() => (screen = "navigate")} />
  {:else}
    <Navigate onExit={() => (screen = "plan")} />
  {/if}

  <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
    {live}
  </div>
</main>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #111;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
    height: 100%;
  }
  :global(*) { box-sizing: border-box; }
  :global(:focus-visible) { outline: 3px solid #1a6; outline-offset: 2px; }
  main {
    min-height: 100vh;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .topbar {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem;
    border-bottom: 1px solid #eee;
    position: sticky;
    top: 0;
    background: #fff;
    z-index: 10;
  }
  .topbar button {
    flex: 1;
    min-height: 2.75rem;
    border: 1px solid #888;
    background: #fff;
    border-radius: 0.4rem;
    font-weight: 600;
    cursor: pointer;
  }
  .topbar button.active {
    background: #246;
    color: #fff;
    border-color: #246;
  }
  .sr-only {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    :global(*) {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
