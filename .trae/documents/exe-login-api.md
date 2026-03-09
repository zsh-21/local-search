## EXE 登录接口学习文档

### 简介
- 目标：为桌面 EXE 提供独立登录接口，但与网站登录保持一致（同一套数据库与账号体系，互通）。
- 结果：新增 `POST /api/exe/login`，复用现有登录校验逻辑（账号解析、密码校验、JWT 颁发、返回 user 信息）。同时在“支付成功”后自动更新用户会员状态，并在登录成功时返回会员到期信息，便于 EXE 端开放会员功能。
- **2026-03-09 更新**：增加设备数量限制，每个账号最多允许在 2 台设备同时登录。

### 接口说明
**请求地址**
- `POST /api/exe/login`

**请求体**
- `account`: string（手机号/邮箱/昵称均可）
- `password`: string（支持前端 AES 加密后的字符串，也支持明文；后端会做兼容解密）
- `deviceId`: string (**必填**) 设备唯一标识（如机器码、MAC地址等），用于设备数量限制校验

示例：
```json
{
  "account": "13800138000",
  "password": "your-password-or-encrypted",
  "deviceId": "unique-device-id-12345"
}
```

**响应体**
- 成功时：`{ code: 0, data: { token, user, membership? }, message: "" }`
- 失败时：
  - `400`: 参数错误（如缺少 deviceId）
  - `401`: 账号或密码错误
  - `403`: 设备超限（该账号已在两台设备登录）

成功示例（有效会员）：
```json
{
  "code": 0,
  "data": {
    "token": "BearerTokenHere",
    "user": {
      "id": "xxx",
      "nickname": "xxx",
      "phone": "13800138000",
      "email": "xx@xx.com",
      "avatarText": "nickname-initials",
      "theme": "light/dark",
      "primaryColor": "#hex",
      "memberExpiresAt": "2026-03-31T12:00:00.000Z"
    },
    "membership": {
      "expiresAt": "2026-03-31T12:00:00.000Z"
    },
    "config": {
      "maxDevices": 2
    }
  },
  "message": ""
}
```

成功示例（非会员或已过期，不返回 `membership`）：
```json
{
  "code": 0,
  "data": {
    "token": "BearerTokenHere",
    "user": {
      "id": "xxx",
      "nickname": "xxx",
      "phone": "13800138000",
      "email": "xx@xx.com",
      "avatarText": "nickname-initials",
      "theme": "light/dark",
      "primaryColor": "#hex"
    },
    "config": {
      "maxDevices": 2
    }
  },
  "message": ""
}
```

失败示例（设备超限）：
```json
{
  "code": 403,
  "message": "该账号已在2台设备登录，请退出其他设备后重试"
}
```

### 核心实现逻辑细节

#### 1. 账号解析 (Account Parsing)
服务端会根据 `account` 的格式自动识别用户身份类型：
- **手机号优先**：若 `account` 为 11 位纯数字（正则 `/^\d{11}$/`），优先作为手机号在数据库中查找。
- **邮箱识别**：若非手机号且包含 `@` 符合邮箱格式（正则 `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`），则作为邮箱在数据库中查找（查找时会统一转为小写）。
- **昵称兜底**：若以上均不符合，则作为 `nickname`（昵称）在数据库中查找。

#### 2. 密码解密与校验 (Password Verification)
为了兼容网站前端的加密逻辑，服务端采用以下步骤：
- **AES 解密**：
  - 使用密钥 `file-search-admin-secret-key-2024` 进行解密。
  - 若解密失败（如输入是明文）或解密后为空，服务端会自动回退并使用原始输入的 `password` 字符串。
- **Hash 对比**：
  - 使用 `bcrypt.compare()` 将得到的明文密码与数据库中存储的 `passwordHash` 进行比对，确保安全性。

#### 3. 设备数量限制 (Device Limit) - **New**
- 服务端会检查请求中的 `deviceId`。
- 如果该设备 ID 已存在于用户的 `devices` 列表中，允许登录。
- 如果是新设备：
  - 获取系统配置的最大设备数（管理员可配置，默认 2 台）。
  - 检查当前已绑定设备数量。
  - 若已达到最大限制（如 2 台），返回 `403 Forbidden`，提示“该账号已在X台设备登录”。
  - 若未达到限制，将新 `deviceId` 加入列表并允许登录。

#### 4. JWT 颁发 (JWT Issuance)
验证通过后，服务端会签发符合标准的 JWT Token：
- **Payload 载荷**：仅包含 `{ sub: userId }`，其中 `sub` 是用户的唯一 ID。
- **签名算法**：使用服务端配置的 `JWT_SECRET` 进行 HS256 签名。
- **有效期**：根据配置决定（通常为 7d 或更长，适合桌面端持久登录）。

#### 5. 用户信息返回 (User Info)
返回的 `data` 对象包含以下核心字段，方便 EXE 端展示：
- `user`: 用户信息（ID、昵称、手机号、会员到期时间等）
- `config`: 系统配置信息（目前包含 `maxDevices`，告知客户端最大允许设备数）

#### 6. 会员状态与支付联动 (Membership & Payment)
- 登录时的会员判定：当 `memberExpiresAt > 当前时间` 时视为“有效会员”，响应中将包含 `membership.expiresAt` 字段。
- 支付成功自动续期：
  - 接口：`GET /api/payment/status?out_trade_no=ORD...`（需要携带 `Authorization: Bearer <token>`）
  - 当检测到支付成功（`status: 'paid'`），会为对应用户自动续期：
    - 月度订阅：按 `quantity` 月续期
    - 年度订阅：按 `12 × quantity` 月续期
  - 续期基准：
    - 若用户当前仍为有效会员，则在现有到期日基础上顺延；
    - 若已过期或未开通，则从当前时间起算。

### 如何使用（EXE 端）
1. **获取设备标识**：
   - 客户端启动或登录前，获取本地机器唯一标识（Machine ID）。
2. **登录请求**：
   - `POST {API_BASE_URL}/api/exe/login`
   - **必须携带 `deviceId`**。
3. **处理异常**：
   - 若返回 `403`，提示用户设备数量超限。
4. **凭证存储**：
   - 收到 `token` 后，EXE 端应安全存储该字符串（如 Keychain、加密存储）。
5. **接口调用**：
   - 在后续需要身份验证的接口中，在 HTTP Header 中添加：
     `Authorization: Bearer <token>`
6. **会员功能开放**：
    - 登录成功后检查是否存在 `data.membership` 字段：
      - 存在：视为有效会员，开放对应功能；
      - 不存在：保持普通用户权限。
7. **支付后生效**：
    - 完成支付后轮询 `GET /api/payment/status`；
    - 当返回 `status: 'paid'` 时，会员已自动续期；
    - 可再次调用登录接口或拉取用户信息，以刷新到期时间展示。

### 验证方式
- 使用 Postman/Apifox/curl 调用测试：
  - 测试手机号登录：`{"account": "138...", "password": "...", "deviceId": "dev1"}`
  - 测试设备超限：
    1. 使用 `deviceId: "dev1"` 登录成功。
    2. 使用 `deviceId: "dev2"` 登录成功。
    3. 使用 `deviceId: "dev3"` 登录失败（预期 403）。
  - 测试错误密码：预期返回 `code: 401`
- 支付联动验证：
  - 创建并支付一笔订单；
  - 轮询支付状态至 `paid`；
  - 再次登录或拉取用户信息，确认 `memberExpiresAt` 已更新。

### 参考代码
- 路由实现（EXE 登录）：[exe.ts](file:///e:/react/file-search-admin/packages/server/src/routes/exe.ts)
- 密码解密：[crypto.ts](file:///e:/react/file-search-admin/packages/server/src/utils/crypto.ts)
- JWT 签发：[jwt.ts](file:///e:/react/file-search-admin/packages/server/src/auth/jwt.ts)
- 路由挂载：[app.ts](file:///e:/react/file-search-admin/packages/server/src/app.ts)
- 会员字段（用户模型）：[User.ts](file:///e:/react/file-search-admin/packages/server/src/models/User.ts)
- 支付状态与会员续期：[payment.ts](file:///e:/react/file-search-admin/packages/server/src/routes/payment.ts)

### 版本与变更记录
- **2026-03-09**：增加 `deviceId` 校验与 2 台设备限制。
- 2026-02-26：
  - 支付成功自动续期会员（根据订单计划与数量）
  - 登录接口在有效会员时返回 `membership.expiresAt`
