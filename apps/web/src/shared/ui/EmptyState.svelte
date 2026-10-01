<script lang="ts">
  let {
    title,
    body,
    alert = false,
  }: { title: string; body: string; alert?: boolean } = $props();
</script>

<section
  class="min-w-0 py-16"
  aria-live={alert ? "assertive" : "polite"}
  role={alert ? "alert" : undefined}
>
  <h2 class="text-base font-semibold tracking-tight">{title}</h2>
  <p class="mt-2 max-w-prose text-caption text-subtle">{body}</p>
</section>
