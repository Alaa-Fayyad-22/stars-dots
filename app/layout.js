import "./globals.css";
import InstallCapture from "./InstallCapture";

export const metadata = {
  title: "Stars & Dots",
  description: "Guess the 4-digit number with your friends.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icons/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  // iPhone / iPad home-screen app. "default" keeps the status bar solid and
  // readable in light and dark mode (black-translucent would put white text on
  // the light page); the page starts below it.
  appleWebApp: { capable: true, title: "Stars & Dots", statusBarStyle: "default" },
  // Older iOS versions only look for the Apple-prefixed name.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eaf0ec" },
    { media: "(prefers-color-scheme: dark)", color: "#10160f" },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=Chivo+Mono:wght@500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <InstallCapture />
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
