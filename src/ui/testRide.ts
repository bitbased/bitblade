/**
 * Set by Track Studio / Course Builder "Test ride": while it's set, Back / Quit from the lobby, the pause menu
 * and the results screen return to that editor (reopened on the same course) instead of the menus.
 */
export const testRide = { from: null as 'tracks' | 'courses' | null, id: '' };

export function editorName() {
  return testRide.from === 'tracks' ? 'Track Studio' : 'Course Builder';
}
