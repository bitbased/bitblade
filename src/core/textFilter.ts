// Offensive words in other players' text (names, blade names, party names): shown as **** when the player's
// HIDE OFFENSIVE WORDS setting is on (the default). Only what you see changes — nothing sent to anyone else is altered,
// and your own text is never touched. obscenity catches the usual disguises (sh1t, s h i t, ſhit…) without the
// Scunthorpe problem of starring innocent words.
import { asteriskCensorStrategy, englishDataset, englishRecommendedTransformers, RegExpMatcher, TextCensor } from 'obscenity';
import { settings } from './settings';

let matcher: RegExpMatcher | null = null;
/** innocent words the list would otherwise catch */
const ALLOWED = ['cockpit', 'cocktail', 'peacock', 'hancock', 'woodcock', 'shuttlecock', 'gamecock', 'weathercock', 'hitchcock', 'babcock', 'dickens', 'scrapbook', 'cumulus', 'cucumber', 'circumstance', 'documents', 'pussycat', 'pussywillow', 'analysis', 'analog', 'therapist', 'grape', 'drape', 'skyscraper'];
const censor = new TextCensor().setStrategy(asteriskCensorStrategy());

/** someone else's text, as this player wants to see it */
export function clean(s: string): string;
export function clean(s: string | undefined | null): string | undefined | null;
export function clean(s: string | undefined | null) {
  if (!s || !settings.filterWords) return s;
  try {
    matcher ??= new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers, whitelistedTerms: ALLOWED });
    const found = matcher.getAllMatches(s);
    return found.length ? censor.applyTo(s, found) : s;
  } catch { return s; }
}
