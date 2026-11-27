function price(base) {
  const discount = 0.1;
  return base * (1 - discount);
}
module.exports = { price };