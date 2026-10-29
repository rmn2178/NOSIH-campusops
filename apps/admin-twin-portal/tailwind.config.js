/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        linen: '#FAF9F5',
        cotton: '#FFFFFF',
        silk: '#F3F1EC',
        obsidian: '#141413',
        stone: '#63615C',
        stitch: '#E6E4DC',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        cloth: '0 10px 30px -10px rgba(24,24,22,.06), 0 2px 6px -1px rgba(24,24,22,.04)',
        float: '0 24px 70px -24px rgba(24,24,22,.18), 0 4px 14px -4px rgba(24,24,22,.06)',
      },
      animation: {
        'pulse-soft': 'pulseSoft 2.4s ease-in-out infinite',
        'slide-in': 'slideIn .25s ease-out both',
      },
      keyframes: {
        pulseSoft: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '.62' } },
        slideIn: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
    },
  },
  plugins: [],
};
