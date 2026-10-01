// Web app manifest: lets the game be installed to the home screen and open
// full-screen. Colors match the light theme; the dark theme color is set with
// <meta name="theme-color"> media queries in layout.js.
export default function manifest() {
  return {
    id: "/",
    name: "Stars & Dots",
    short_name: "Stars & Dots",
    description: "Guess the secret number with your friends.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#eaf0ec",
    theme_color: "#eaf0ec",
    categories: ["games"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
