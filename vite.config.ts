import { defineConfig } from 'vite'

// Relative base: the same build runs on GitHub Pages (/ZeroPort/) and from file:// inside Electron.
export default defineConfig({ base: './', build: { target: 'es2022' } })
