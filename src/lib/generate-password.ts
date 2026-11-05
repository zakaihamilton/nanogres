const PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateSecurePassword(length = 24): string {
  const limit = Math.floor(256 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length;
  let password = "";

  while (password.length < length) {
    const bytes = new Uint8Array(Math.ceil((length - password.length) * 1.5));
    globalThis.crypto.getRandomValues(bytes);

    for (const byte of bytes) {
      if (byte < limit) password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (password.length === length) break;
    }
  }

  return password;
}
