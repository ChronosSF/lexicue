import { formatCents } from "@subtitle-translator/pricing";
import "./AppHeader.css";
import { Logo } from "./Logo.js";
import { Menu, type MenuItem } from "./Menu.js";

export interface HeaderBalance {
  balanceCents: number;
  /** The unspent part of the $2.50 grant, marked while it lasts (spec 2.2). */
  freeCents: number;
}

/**
 * The header of spec section 2.2: the balance in money, with the free portion
 * marked, and everything else behind one small menu.
 */
export function AppHeader({
  balance,
  onOpenWallet,
  menuItems,
  demoBadge,
}: {
  balance: HeaderBalance | null;
  onOpenWallet: () => void;
  menuItems: MenuItem[];
  demoBadge?: string;
}): React.JSX.Element {
  return (
    <header className="app-header">
      <div className="container app-header-inner">
        <div className="brand">
          <Logo />
          <span className="brand-name">Subtitle Translator</span>
          {demoBadge === undefined ? null : <span className="chip brand-badge">{demoBadge}</span>}
        </div>

        <div className="spacer" />

        {balance === null ? null : (
          <button type="button" className="balance" onClick={onOpenWallet}>
            <span className="balance-label">Balance</span>
            <span className="balance-amount num">{formatCents(balance.balanceCents)}</span>
            {balance.freeCents > 0 ? (
              <span className="chip chip-accent">{formatCents(balance.freeCents)} free credit</span>
            ) : null}
          </button>
        )}

        {menuItems.length === 0 ? null : (
          <Menu label="Account menu" items={menuItems}>
            <span aria-hidden="true" className="menu-glyph">
              ☰
            </span>
            <span className="menu-word">Menu</span>
          </Menu>
        )}
      </div>
    </header>
  );
}
