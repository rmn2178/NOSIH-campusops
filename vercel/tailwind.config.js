/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        linen: '#FAF9F5',
        cotton: '#FFFFFF',
        silk: '#F3F1EC',
        stitch: '#E6E4DC',
        ink: '#141413',
        stone: '#63615C',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        cloth: '0 10px 30px -10px rgba(24, 24, 22, 0.05), 0 2px 6px -1px rgba(24, 24, 22, 0.03)',
        lift: '0 22px 55px -24px rgba(24, 24, 22, 0.18), 0 3px 10px -3px rgba(24, 24, 22, 0.05)',
      },
    },
  },
  plugins: [],
};
