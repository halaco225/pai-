// Shared deck palette + theme switching.
// `C` is mutated in place by applyTheme so every module that required it sees the change.

const BASE_C = {
  navy:   '1E2761',
  gold:   'E07B2A',
  white:  'FFFFFF',
  light:  'F4F6FA',
  dk:     '1E293B',
  green:  '1D9E75',
  red:    'C0392B',
  amber:  'D68910',
  gray:   '64748B',
  lgray:  'E2E8F0',
  border: 'D1D9E6',
  lgred:  'FFF5F5',
};

const THEME_OVERRIDES = {
  'command-dark':   { navy: '111111', light: '1A1A1A', gold: 'CC0000', lgray: '2A2A2A', border: '333333', gray: '888888', dk: 'CCCCCC' },
  'clean-white':    { navy: 'CC0000', light: 'F9F9F9', gold: 'CC0000', border: 'E0E0E0', lgray: 'EEEEEE' },
  'maroon':         { navy: '3D0C0C', light: '2A0808', gold: 'F9A825', lgray: '350E0E', border: '4A1010', gray: 'A07070', dk: 'F0D0D0' },
  'royal-white':    { navy: '003594', light: 'EEF2FA', gold: '4A90D9', border: 'C5D5EE', lgray: 'DCE8FA' },
  'purple-gold':    { navy: '2D0A5E', light: '1A0535', gold: 'F5C518', lgray: '250845', border: '350A70', gray: 'A080C0', dk: 'E0C0FF' },
  'forest-gold':    { navy: '1A4731', light: '102C1E', gold: 'B8960C', lgray: '183D28', border: '204F33', gray: '709080', dk: 'C0E0D0' },
  'navy-orange':    { navy: '0D1B2A', light: '071018', gold: 'E85D04', lgray: '0E1E30', border: '152438', gray: '607080', dk: 'C0D0E0' },
  'black-gold':     { navy: '0F0F0F', light: '1A1A0A', gold: 'C9A84C', lgray: '222215', border: '333320', gray: '807060', dk: 'E0D0B0' },
  'slate-teal':     { navy: '1C3A4A', light: '0E2030', gold: '00B4D8', lgray: '152C3A', border: '1E3A4A', gray: '608090', dk: 'C0D8E8' },
  'crimson-silver': { navy: '6B0F1A', light: '3D0810', gold: 'A8A9AD', lgray: '4A0E18', border: '5A1220', gray: 'A09090', dk: 'E0C0C0' },
};

const C = { ...BASE_C };

function applyTheme(slug) {
  Object.assign(C, BASE_C, THEME_OVERRIDES[slug] || {});
  return C;
}

// Dark themes need light body text on white-ish cards flipped the other way.
function isDark(slug) {
  return !!THEME_OVERRIDES[slug] && parseInt((THEME_OVERRIDES[slug].light || 'FFFFFF').slice(0, 2), 16) < 0x60;
}

module.exports = { C, BASE_C, THEME_OVERRIDES, applyTheme, isDark };
