/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          900: '#1a2151',
          800: '#1e2a5e',
          700: '#23326c',
          600: '#283b79',
          500: '#2d4487',
          400: '#324c94',
          300: '#3755a2',
          200: '#3c5eaf',
          100: '#4166bd',
        }
      }
    },
  },
  plugins: [],
} 