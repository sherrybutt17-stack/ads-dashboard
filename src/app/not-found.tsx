import Link from "next/link";

/**
 * Root 404.
 *
 * `notFound()` is called from the client dashboard for an unknown slug, and
 * there was nothing to render — so a mistyped URL produced Next's unstyled
 * default page, which reads as a broken deployment rather than a wrong address.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-full max-w-[520px] flex-col justify-center px-4 py-16">
      <div className="card p-7">
        <p
          className="text-[11px] font-semibold tracking-wider uppercase"
          style={{ color: "var(--text-muted)" }}
        >
          404
        </p>
        <h1
          className="mt-1 text-lg font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          Nothing here
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          That page doesn&rsquo;t exist. If you followed a link to a client
          dashboard, the client may have been archived or the address may have a
          typo in it.
        </p>
        <Link
          href="/"
          className="btn-accent mt-5 inline-flex w-fit"
        >
          All clients
        </Link>
      </div>
    </div>
  );
}
