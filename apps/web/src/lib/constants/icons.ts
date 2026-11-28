/** Shared 24×24 SVG path data for filled icons used across pages. */
export const ICONS = {
	grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
	bolt: 'M13 2L4 14h6l-1 8 9-12h-6z',
	upload: 'M12 3l5.5 5.5-1.4 1.4L13 6.8V16h-2V6.8L7.9 9.9 6.5 8.5zM4 18h16v2H4z',
	bookmark: 'M6 3h12a1 1 0 011 1v17l-7-4-7 4V4a1 1 0 011-1z',
	clock: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v5.4l4 2.4-1 1.7-5-3V7z',
	star: 'M12 2l2.9 6.3 6.9.8-5 4.7 1.3 6.8L12 17.4 5.9 20.6 7.2 13.8l-5-4.7 6.9-.8z',
	crown: 'M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5z',
	pencil:
		'M4 17.2V20h2.8l8.3-8.3-2.8-2.8zm15.7-9.5a1 1 0 000-1.4l-2-2a1 1 0 00-1.4 0l-1.6 1.6 2.8 2.8z',
	camera:
		'M9 4l-1.5 2H4a1 1 0 00-1 1v12a1 1 0 001 1h16a1 1 0 001-1V7a1 1 0 00-1-1h-3.5L15 4zm3 4.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9zm0 2a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
	calendar:
		'M7 2h2v2h6V2h2v2h3a1 1 0 011 1v15a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1h3zm-2 8v9h14v-9z',
	check: 'M9.5 16.2L5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z',
	replay: 'M12 5V2L7 6l5 4V7a5 5 0 11-5 5H5a7 7 0 107-7z',
	trash: 'M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7zm4 2v8h1.5v-8zm2.5 0v8H14v-8z',
	warning: 'M12 2L1 21h22zm-1 7h2v6h-2zm0 8h2v2h-2z'
} as const;
