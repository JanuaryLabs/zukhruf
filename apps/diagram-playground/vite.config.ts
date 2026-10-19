import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// The @zukhruf/source condition resolves @zukhruf/diagram and @zukhruf/shadcn
// to their src folders, so an edit there reloads with no build.
export default defineConfig({
  resolve: {
    conditions: ['@zukhruf/source', ...defaultClientConditions],
  },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
});
