# Google Stitch UI Specification (AeroYTDL Design System)

This document formalizes the Google Stitch and Material 3 Dark inspired Design System rules used to build the premium, high-fidelity developer dashboard interface of AeroYTDL.

---

## 1. Color Palette (Deep Space Glow)

Google Stitch emphasizes high-contrast dark modes, vibrant key colors, and soft glowing accents.

| Token | HSL / Hex | Purpose |
|---|---|---|
| `--bg-darker` | `#050508` | Base application background |
| `--bg-main` | `#0b0c10` | Canvas base layer |
| `--bg-card` | `rgba(22, 24, 33, 0.7)` | Translucent glass container cards |
| `--bg-card-hover` | `rgba(30, 33, 47, 0.85)` | Elevated glass container on hover |
| `--border-color` | `rgba(255, 255, 255, 0.08)` | Subtle UI borders |
| `--border-color-focus`| `rgba(139, 92, 246, 0.4)` | Focus outlines / Glow markers |
| `--primary` | `#8b5cf6` | Google Stitch Purple Key color |
| `--primary-light` | `#a78bfa` | High contrast labels and badges |
| `--success` | `#10b981` | Positive statuses (Connected, Success) |
| `--error` | `#f43f5e` | Fatal statuses (Disconnected, Error) |

---

## 2. Typography

We utilize clean Google Fonts to provide an official developer-telemetry look:

*   **Headings**: `Outfit` (sans-serif, weights: 600, 700) with `-0.02em` tracking for a modern, compact, premium title look.
*   **Body**: `Inter` (sans-serif, weights: 400, 500) for high legibility in system cards and control labels.
*   **Terminal & Telemetry**: `JetBrains Mono` (monospace) for telemetry banners, filenames, terminal logs, and system paths.

---

## 3. Motion & Micro-interactions

Google Stitch features smooth, responsive micro-animations:

*   **Standard Transitions**: `0.25s cubic-bezier(0.4, 0, 0.2, 1)` for container hover elevations and color changes.
*   **Entrance Animations**: `fadeIn` entry for card headers and analysis items (`0.4s cubic-bezier(0.16, 1, 0.3, 1)`).
*   **Active Scale**: `transform: scale(0.98)` or translation on press to give buttons tactile feedback.

---

## 4. Layout & Grid Structures

*   **Dashboard Grid**: 2-column layout (Active Tasks on the left, browser-saved history logs on the right).
*   **Interactive Demo Badges**: Badges with subtle border glows and scale transitions that load test urls to allow rapid workflow testing.
*   **Control Center Telemetry Banner**: Floating system info header with state badges for CPU/OS, active queue counters, storage history metrics, and live WebSocket heartbeat animations.
