import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ads + CRM Dashboard",
  description: "Live Facebook Ads and GoHighLevel pipeline reporting",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        {/*
          Apply the theme before first paint. Bold dark-first: dark is the
          deliberate default, so absent a stored preference we stamp `dark`
          rather than following the OS. A user who picks light gets it persisted
          and honoured here. Stamping before paint avoids the theme flash on
          every navigation.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');document.documentElement.dataset.theme=(t==='light'||t==='dark')?t:'dark'}catch(e){document.documentElement.dataset.theme='dark'}`,
          }}
        />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
