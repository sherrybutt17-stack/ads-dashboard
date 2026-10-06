import Link from "next/link";
import { AppShell } from "@/components/AppShell";

/**
 * Root 404.
 *
 * `notFound()` is called from the client dashboard for an unknown slug, and
 * there was nothing to render — so a mistyped URL produced Next's unstyled
 * default page, which reads as a broken deployment rather than a wrong address.
 *
 * The violet panel is the one place in the product where a decorative gradient
 * earns its keep: there is no data on this page to compete with it, and it says
 * "you are still inside the product" louder than any amount of body copy.
 */
export default function NotFound() {
  return (
    <AppShell>
      <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center px-4 py-16 sm:px-6">
        <div className="card-hero flex flex-col items-start gap-1 px-6 py-7">
          <span className="eyebrow">Not found</span>
          <p className="tnum text-[46px] leading-none font-semibold tracking-[-0.03em]">
            404
          </p>
        </div>

        <h1
          className="mt-6 text-[26px] leading-tight font-semibold tracking-[-0.02em]"
          style={{ color: "var(--text-primary)" }}
        >
          Nothing here
        </h1>
        <p
          className="mt-2.5 max-w-[46ch] text-sm leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          That page doesn&rsquo;t exist. If you followed a link to a client
          dashboard, the client may have been archived or the address may have a
          typo in it.
        </p>

        <Link href="/" className="btn-accent mt-6 w-fit">
          All clients
        </Link>
      </main>
    </AppShell>
  );
}
