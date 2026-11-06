// ============================================================================
//  CAMPAIGN CONFIG — edit this file to customise the site. No other code changes needed.
// ============================================================================
window.CAMPAIGN_CONFIG = {
  // Path or URL of the official CORSAIR logo (SVG/PNG). Leave '' to show a labelled placeholder.
  logoUrl: '',

  // Where the buttons go. Replace the placeholder URLs before launch.
  links: {
    learnMore:  'https://example.com/corsair-bd/learn-more',
    dealer:     'https://example.com/corsair-bd/authorized-dealers',
    bangladesh: 'https://example.com/corsair-bd',
    official:   'https://www.corsair.com/'
  },

  // Game rules
  game: {
    duration: 60,   // seconds per round
    lives: 3        // catching an unofficial box costs one life
  },

  // Performance titles shown on the results screen (highest matching "min" wins).
  ranks: [
    { min: 0,   title: 'ROOKIE SHOPPER',        message: 'Good start! Look for the Smart Warranty sticker and try again.' },
    { min: 200, title: 'SMART SHOPPER',         message: 'Nice eye! You are getting the hang of spotting the sticker.' },
    { min: 500, title: 'AUTHENTICITY EXPERT',   message: 'Excellent! You know exactly what to look for on the box.' },
    { min: 900, title: 'STICKER MASTER',        message: 'Flawless! Nothing unofficial gets past you.' }
  ]
};
