/* @rs:config sheet: キャパシティ (環境別) instance: prod */

/* @rs:category DynamoDB */
export const capacity = {
  readCapacity: 50, // @rs 読み込みキャパシティ @rs:default 5
  writeCapacity: 25, // @rs 書き込みキャパシティ @rs:default 5
  autoScaling: true, // @rs オートスケール @rs:remarks 本番はピークに合わせて有効
};
