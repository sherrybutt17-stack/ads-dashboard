import type { Metadata } from "next";
import localFont from "next/font/local";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

/*
 * Plus Jakarta Sans — the interface face.
 *
 * Loaded with `next/font/local` off the @fontsource-variable package rather
 * than `next/font/google`, for two reasons that both bite at the wrong moment:
 * the Google loader fetches the file at BUILD time, so a build on a machine
 * without network access fails outright; and it emits a request to a Google
 * host at install, which is exactly the third-party call the report route is
 * not allowed to make. This copy ships in node_modules, is self-hosted from
 * our own origin, and is subset to latin + latin-ext.
 *
 * One variable file covers 200–800, so every weight the design uses costs a
 * single download. `display: swap` means text paints in the fallback and
 * re-renders rather than sitting invisible — and the fallback is deliberately
 * a geometric-ish system stack so the reflow is small.
 */
const jakarta = localFont({
  src: [
    {
      path: "../../node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2",
      style: "normal",
    },
    {
      path: "../../node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-italic.woff2",
      style: "italic",
    },
  ],
  weight: "200 800",
  variable: "--font-jakarta",
  display: "swap",
  fallback: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "system-ui", "sans-serif"],
});

export const metadata: Metadata = {
  title: "Ads + CRM Dashboard",
  description: "Live Facebook Ads and GoHighLevel pipeline reporting",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`h-full ${jakarta.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
          Apply the theme before first paint.

          The default flipped with the redesign: this is now a light-first
          product — a soft grey canvas with a floating frame — and dark is the
          supported alternative rather than the house style. Absent a stored
          preference we stamp `light` rather than following the OS, for the same
          reason we used to stamp `dark`: the agency shows this screen to
          clients, and the look it opens with should be the one that was
          designed, not whatever the laptop happens to be set to.

          A user who picks either gets it persisted and honoured here. Stamping
          before paint is what avoids the theme flash on every navigation, so
          this must stay a blocking inline script in <head>; moving it into a
          component or deferring it reintroduces the flash.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');document.documentElement.dataset.theme=(t==='light'||t==='dark')?t:'light'}catch(e){document.documentElement.dataset.theme='light'}`,
          }}
        />
      </head>
      {/*
        Suppressed for the same reason as <html>, but a different culprit:
        browser extensions inject attributes onto <body> before React
        hydrates — ColorZilla's `cz-shortcut-listen`, password managers,
        grammar checkers — and React reports each one as a hydration mismatch.
        Observed on /login as a red console error caused by nothing in this
        codebase. The flag covers attributes on this element only, so a real
        mismatch in the tree below still reports normally.
      */}
      <body className="flex min-h-full flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
