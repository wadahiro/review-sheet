/* @rs:config sheet: キャパシティ (環境別) instance: dev */

/* @rs:category DynamoDB */
export const capacity = {
  readCapacity: 5, // @rs 読み込みキャパシティ @rs:default 5
  writeCapacity: 5, // @rs 書き込みキャパシティ @rs:default 5
  autoScaling: false, // @rs オートスケール @rs:remarks dev は無効
};
