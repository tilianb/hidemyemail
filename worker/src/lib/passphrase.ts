const WORDS = [
  "apple", "brave", "crane", "drift", "eagle", "flame", "ghost", "heart", "ivory", "juice",
  "knife", "lemon", "magic", "night", "ocean", "pearl", "quiet", "river", "stone", "train",
  "union", "voice", "water", "xenon", "yacht", "zebra", "alert", "brick", "cloud", "dance",
  "earth", "frost", "grape", "honey", "index", "jelly", "koala", "laser", "mango", "ninja",
  "orbit", "piano", "quilt", "radar", "sugar", "tiger", "umbra", "venom", "wheat", "x-ray",
  "yield", "zonal", "amber", "blade", "crisp", "diner", "elite", "fable", "glint", "hound",
  "inbox", "joker", "kneel", "lunar", "medal", "novel", "oasis", "pulse", "query", "roast",
  "scout", "tulip", "unify", "viper", "whale", "xerox", "yearn", "zesty", "acorn", "baker",
  "cider", "delta", "ember", "forge", "grill", "hazel", "igloo", "judge", "kiosk", "latch",
  "melon", "nexus", "opera", "plumb", "quirk", "ridge", "salsa", "tonic", "usher", "vivid"
];

export function generatePassphrase(): string {
  const array = new Uint32Array(6);
  crypto.getRandomValues(array);
  const selected = [];
  for (let i = 0; i < 6; i++) {
    selected.push(WORDS[array[i] % WORDS.length]);
  }
  return selected.join("-");
}
