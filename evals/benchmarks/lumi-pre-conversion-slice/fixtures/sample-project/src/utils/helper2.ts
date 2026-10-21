export function computeHash2(input: string): string {
  let h = 0;
  for (let j = 0; j < input.length; j++) h = (h << 5) - h + input.charCodeAt(j);
  return (h >>> 0).toString(16);
}
