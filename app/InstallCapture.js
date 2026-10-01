"use client";

// Loads lib/install.js on every page so the browser's install offer is caught
// no matter which page the visit started on. Renders nothing.
import "@/lib/install";

export default function InstallCapture() { return null; }
