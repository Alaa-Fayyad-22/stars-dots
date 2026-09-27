import "./globals.css";

export const metadata = {
  title: "Stars & Dots",
  description: "Guess the 4-digit number with your friends.",
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
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
