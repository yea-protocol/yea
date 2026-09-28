/** The made-up menu behind the shop example: 60 meals built from 20 dishes, and the shape of an order. */

const MENU: [string, string[]][] = [
  ['Miso Glazed Salmon', ['high-protein']],
  ['Chicken Tikka Masala', ['high-protein', 'spicy']],
  ['Mushroom Risotto', ['vegetarian']],
  ['Beef Bulgogi Bowl', ['high-protein', 'spicy']],
  ['Falafel Plate', ['vegan', 'vegetarian']],
  ['Turkey Chili', ['high-protein', 'spicy']],
  ['Tofu Pad Thai', ['vegan', 'vegetarian']],
  ['Lemon Herb Chicken', ['high-protein']],
  ['Shrimp Tacos', ['spicy']],
  ['Lentil Curry', ['vegan', 'vegetarian', 'spicy']],
  ['Steak Frites', ['high-protein']],
  ['Veggie Lasagna', ['vegetarian']],
  ['Cod Piccata', ['high-protein']],
  ['Pork Carnitas', ['high-protein']],
  ['Chickpea Shawarma', ['vegan', 'vegetarian']],
  ['Teriyaki Chicken', ['high-protein']],
  ['Eggplant Parm', ['vegetarian']],
  ['Salmon Poke', ['high-protein']],
  ['Chicken Pho', ['high-protein']],
  ['Black Bean Burrito', ['vegan', 'vegetarian']],
];

export interface Meal {
  sku: string;
  name: string;
  price: number;
  cal: number;
  protein: number;
  tags: string[];
}

export const catalog: Meal[] = Array.from({ length: 60 }, (_, i) => ({
  sku: `m${String(i + 1).padStart(3, '0')}`,
  name:
    MENU[i % MENU.length][0] +
    (i >= MENU.length
      ? ` (${['family', 'light'][Math.floor(i / MENU.length) - 1]})`
      : ''),
  price: 1099 + ((i * 137) % 900),
  cal: 420 + ((i * 53) % 380),
  protein: 18 + ((i * 7) % 30),
  tags: MENU[i % MENU.length][1],
}));

export interface Order {
  id: string;
  total: number;
  status: string;
}
