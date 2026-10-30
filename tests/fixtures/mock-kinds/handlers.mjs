// A stateful mock: a POST adds a note and the next GET lists it. State is per capture, so the before
// and after sides each start empty.
export function notes(request, state) {
  state.notes ??= [];
  if (request.method === 'POST') {
    state.notes.push(request.json.text);
    return { status: 201, json: { ok: true } };
  }
  return { json: { notes: state.notes } };
}
