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
          Apply the stored theme before first paint. Without this the page
          renders in the OS theme and then snaps to the stored preference,
          which is a visible flash on every navigation.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
