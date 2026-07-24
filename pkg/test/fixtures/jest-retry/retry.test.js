let attempts = 0;

jest.retryTimes(1);

test("passes only on its retry", () => {
  attempts += 1;
  expect(attempts).toBe(2);
});
