import type { Track, CategoryDef } from '../types';
import { loadCustomTracks } from './trackResolver';

// Source: B1 of each Track sheet. A future parser would extract these.
export const TRACKS: Track[] = [
  {
    id: 1,
    artist: 'C. Tangana',
    name: 'Nunca Estoy',
    spotifyId: '6N4ioa3XSbvjmwdVEERl8F',
    spotifyUrl: 'https://open.spotify.com/track/6N4ioa3XSbvjmwdVEERl8F',
    sheetName: 'Track 1',
    audioLabel:
      'C. Tangana - Nunca Estoy https://open.spotify.com/track/6N4ioa3XSbvjmwdVEERl8F?si=177c269c6ad94d41',
  },
  {
    id: 2,
    artist: 'Izi',
    name: 'Chic',
    spotifyId: '7jUJ2RmT4PFHHq4goMWqm3',
    spotifyUrl: 'https://open.spotify.com/track/7jUJ2RmT4PFHHq4goMWqm3',
    sheetName: 'Track 2',
    audioLabel:
      'Izi - Chic https://open.spotify.com/track/7jUJ2RmT4PFHHq4goMWqm3?si=a389ccfebd684108',
  },
  {
    id: 3,
    artist: 'Solomon Ray',
    name: 'Find Your Rest',
    spotifyId: '3XZMl51zqZDdAb0rwzSuxz',
    spotifyUrl: 'https://open.spotify.com/track/3XZMl51zqZDdAb0rwzSuxz',
    sheetName: 'Track 3',
    audioLabel:
      'Solomon Ray - Find Your Rest https://open.spotify.com/track/3XZMl51zqZDdAb0rwzSuxz?si=0de6d87aeb41496e',
  },
];

/**
 * Returns the active track list.
 * Uses custom tracks from localStorage if saved, otherwise falls back to the
 * hardcoded TRACKS array.
 */
export function getActiveTracks(): Track[] {
  const custom = loadCustomTracks();
  if (custom && custom.length > 0) return custom;
  return TRACKS;
}

// Hard structural limit from the Excel template. Never exceed.
export const MAX_TIMELINE_ROWS = 10;

// Section type chips are SHORTCUTS — not a closed vocabulary.
export const SECTION_TYPE_SHORTCUTS = [
  'Intro',
  'Verse',
  'Pre-Chorus',
  'Chorus',
  'Bridge',
  'Break',
  'Build',
  'Drop',
  'Solo',
  'Outro',
  'Hook',
  'Instrumental',
];

// Tag suggestions are FREEFORM APPEND helpers — not controlled vocabulary.
export const TAG_SUGGESTIONS: Record<string, string[]> = {
  Instruments: [
    'Piano',
    'Electric Guitar',
    'Acoustic Guitar',
    'Bass',
    'Drums',
    'Synth',
    'Strings',
    'Brass',
    '808',
    'Rhodes',
    'Organ',
    'Flute',
    'Violin',
    'Trumpet',
    'Pads',
    'Shaker',
    'Percussion',
    'Saxophone',
    'Cello',
    'Keys',
  ],
  Vocals: [
    'Male Vocals',
    'Female Vocals',
    'Rap',
    'Harmonies',
    'Falsetto',
    'Autotune',
    'Whisper',
    'Screaming',
    'Choir',
    'Ad-libs',
    'Vocoder',
    'No Vocals',
  ],
  'Energy & Vibe': [
    'High Energy',
    'Low Energy',
    'Sparse',
    'Dense',
    'Wall-of-Sound',
    'Minimal',
    'Lo-fi',
    'Melancholic',
    'Dark',
    'Euphoric',
    'Chill',
    'Intense',
    'Dreamy',
    'Gritty',
    'Warm',
    'Nostalgic',
    'Intimate',
    'Triumphant',
    'Mysterious',
  ],
  Production: [
    'Sub-bass',
    'Distortion',
    'Heavy Reverb',
    'Dry',
    'Wide Stereo',
    'Mono',
    'Live Feel',
    'Electronic',
    'Glitchy',
    'Punchy',
    'Layered',
    'Raw',
  ],
};

// Category definitions — excelLabel values are EXACT column A text in template.
export const GLOBAL_CATEGORIES: CategoryDef[] = [
  {
    key: 'genre',
    excelLabel: 'GENRE, ERA, & SCENE',
    displayLabel: 'GENRE, ERA & SCENE',
    guidance:
      'Can include broad and subgenre (e.g. Glam Rock), a specific decade (e.g. 80s Synthwave), and cultural scene (e.g. Club). What is most important is what it sounds like.',
    canBeNA: false,
  },
  {
    key: 'instrumentation',
    excelLabel: 'INSTRUMENTATION',
    displayLabel: 'INSTRUMENTATION',
    guidance:
      'List the dominant instruments. Mention specific unique sounds (e.g. 808 bass, distorted cello). You can add roles and properties (e.g. "Detuned Rhythmic bass").',
    suggestedTags: TAG_SUGGESTIONS['Instruments'],
    canBeNA: false,
  },
  {
    key: 'mix',
    excelLabel: 'MIX & PRODUCTION',
    displayLabel: 'MIX & PRODUCTION',
    guidance:
      'Describe the Sound Stage. Dry vs Wet (Reverb)? Wide vs Mono? Warm/Vintage vs Cold/Digital? Minimal vs Wall-of-Sound?',
    suggestedTags: TAG_SUGGESTIONS['Production'],
    canBeNA: false,
  },
  {
    key: 'playing',
    excelLabel: 'PLAYING STYLE',
    displayLabel: 'PLAYING STYLE',
    guidance:
      'How is it performed? Tight/Quantized? Loose/Human? Aggressive? Gentle/Intimate? Robotically precise?',
    canBeNA: false,
  },
  {
    key: 'vocals',
    excelLabel: 'VOCAL EXPRESSION',
    displayLabel: 'VOCAL EXPRESSION',
    guidance:
      'Describe the voice. Gender? Pitch? Timbre (Raspy, Breathy, Clean)? Delivery (Rap, Croon, Scream)? Processing (Autotune, Vocoder)?',
    suggestedTags: TAG_SUGGESTIONS['Vocals'],
    canBeNA: true,
  },
  {
    key: 'emotion',
    excelLabel: 'EMOTION & VIBE',
    displayLabel: 'EMOTION & VIBE',
    guidance:
      'How does it feel? (e.g. Happy, Anxious, Triumphant, Chill, Dark, Nostalgic). How does the energy evolve across the track?',
    suggestedTags: TAG_SUGGESTIONS['Energy & Vibe'],
    canBeNA: false,
  },
  {
    key: 'lyrics',
    excelLabel: 'LYRICAL EVOCATION',
    displayLabel: 'LYRICAL EVOCATION',
    guidance:
      'If lyrics stand out, what are they about? (e.g. Love, Politics, Party, Storytelling). If instrumental, write N/A. Do not deeply analyse.',
    canBeNA: true,
  },
  {
    key: 'quality',
    excelLabel: 'SONIC FIDELITY & PROFICIENCY (QUALITY)',
    displayLabel: 'SONIC FIDELITY & QUALITY',
    guidance:
      "Is this Pro or Amateur? Note flaws (clipping, bad tuning, clumsy drumming) only when NOT serving the material. Lo-fi can be intentional. Be honest — don't just be polite.",
    canBeNA: false,
  },
  {
    key: 'wow',
    excelLabel: "THE 'WOW' FACTOR",
    displayLabel: "THE 'WOW' FACTOR",
    guidance:
      "CRITICAL: What makes this song unique? A surprise drop? Weird instrument pairing? The ONE thing you'd tell a friend. Why is it not generic?",
    canBeNA: false,
  },
];

export const STYLE_RULES = [
  {
    num: 1,
    title: 'TIME IS PRECIOUS',
    body: 'Do not spend more than 30 minutes on a track. 20 minutes is the sweet spot.',
    defaultExpanded: false,
  },
  {
    num: 2,
    title: 'THE FOREGROUND RULE',
    body: 'If a sound is faint or you have to squint to hear it, ignore it. Focus on what is obvious and driving the song.',
    defaultExpanded: false,
  },
  {
    num: 3,
    title: 'AVOID VERBOSITY',
    body: 'Include all key information but keep sentences concise. Avoid superfluous adjectives.',
    defaultExpanded: false,
  },
  {
    num: 4,
    title: 'GROUNDED SUBJECTIVITY',
    body: "Be specific. Instead of 'It sounds nice', say 'Warm mix with smooth vocals'.",
    defaultExpanded: false,
  },
  {
    num: 5,
    title: 'WHAT IT SOUNDS LIKE',
    body: "Trust your ears. 'Sounds like a distorted cello' beats 10 minutes of googling. If you can't describe it easily, skip it.",
    defaultExpanded: false,
  },
  {
    num: 6,
    title: 'NON-EXHAUSTIVE',
    body: "Don't list everything — too tedious. Focus on what stands out.",
    defaultExpanded: false,
  },
  {
    num: 7,
    title: 'YOU CAN SKIP',
    body: "If you feel too disconnected to say accurate things, remove what you wrote and write SKIPPED.",
    defaultExpanded: false,
  },
  {
    num: 8,
    title: 'CONVERSATIONAL',
    body: "No need for exact BPM or chord names. Cues like 'jazzy chords' or 'slow tempo' are fine.",
    defaultExpanded: false,
  },
  {
    num: 9,
    title: 'CONSISTENT STYLE',
    body: "Use present tense. No first-person. No 'In this song'. Matter-of-fact but emotions are welcome.",
    defaultExpanded: true,
  },
  {
    num: 10,
    title: 'CONTEXT & RELATIONSHIP',
    body: "Use Who/What/Where/When: 'The singer (who) screams (what) and takes center stage (where) during the chorus (when)'.",
    defaultExpanded: true,
  },
];

export const NARRATIVE_PROMPTS_FIRST = [
  'How does the song open?',
  'What is the very first thing you hear?',
  'What instruments or sounds establish the mood?',
];

export const NARRATIVE_PROMPTS_SUBSEQUENT = [
  'What changed from the previous section?',
  'What is now happening that was not before?',
  'Did the energy level rise or drop?',
  'Did the rhythm, density, or texture shift?',
];
