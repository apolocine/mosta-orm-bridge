// case-conversion.ts
// Author: Dr Hamid MADANI drmdh@msn.com

/** PascalCase (User) to snake_case plural (users) — naive pluralization */
export function modelToCollection(modelName: string): string {
  const snake = modelName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(snake)) return snake + 'es';
  if (/[^aeiou]y$/.test(snake)) return snake.slice(0, -1) + 'ies';
  return snake + 's';
}

/** PascalCase (User) to camelCase (user) */
export function pascalToCamel(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

/** camelCase or PascalCase to PascalCase */
export function toPascalCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
