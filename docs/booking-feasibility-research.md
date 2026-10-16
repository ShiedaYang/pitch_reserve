# 场地预订可行性：官方来源核查

核查日期：2026-10-15（Europe/London）。本文件记录公开官网、官网直接链接的条款及只读获取的官方页面 HTML，不代表已完成登录、实时库存扫描、占位或付款。当前用户规格：未来两个日历月内、周一至周四、18:00 开始；四个入口合计每周最多一场；正常单次场租；GGCB 半场、Stepney Green 三分之一场、PlayFootball Westferry 普通 5v5 产品 85、Poplar 普通 7v7 产品 88。PlayFootball 不选联赛或特殊活动，不再将 Westferry 的 6v6 许可核实作为阻塞条件。GGCB 实际销售时长 55 分钟必须展示，尚不应假定用户已接受完整 60 分钟的替代。

## 已核实的场馆和放号信息

| 用户入口 | 已核实 | 放号/提前预订窗口 | 未付款占位证据 |
| --- | --- | --- | --- |
| [GGCB 6-a-side](https://ggcb.co.uk/booking/6-a-side-3g-half-pitch/) | George Green’s School；6v6 半场；两块场地；销售时长 55 分钟；页面注明 Europe/London | 页面写次月日期在提前 7 天时才释放，不是所有日期滚动提前 7 天 | 本次查阅页面未提供购物篮或未付款订单的锁场时长 |
| [Tower Hamlets 表单](https://towerhamlets-self.achieveservice.com/service/Book_a_sports_pitch) | 官网在 Stepney Green Park 3G 一节直接链接该表单；不能当作全部 council 球场的统一库存入口 | 条款有 “two days in advance” 表述，含义与实际可选范围需登录后验证 | 条款写在线付款确认；本次未找到有时限的未付款占位说明 |
| [PlayFootball Canary Wharf](https://www.playfootball.net/venues/canary-wharf/book-a-pitch/85/5-a-Side3GPitchHire) | 实际场馆名称 Canary Wharf - Westferry；Cyril Jackson Primary School；5 人制 3G | 场馆页写可提前 30 天；通用在线条款写通常提前 28 天，可调整 | 通用在线条款第 2.2 条写未付款预订最多保留 30 分钟，之后自动取消 |
| [PlayFootball Poplar](https://www.playfootball.net/venues/canary-wharf-poplar/book-a-pitch/88/7-a-Side3GPitchHire) | Our Lady & St Joseph Catholic Primary School；7 人制 3G | 场馆页同样写提前 30 天；同样受通用条款 28 天表述差异影响 | 同上；需要实际结账流程验证何时创建占位及到期时间 |

GGCB 原文为 “The dates for the following month are only released 7 days prior.” 这支持按月放号的初步判断，但未给准确日期、时刻或节假日例外，不能将其写成已证实的每月 24/25 日 00:00 放号。[GGCB 场地页](https://ggcb.co.uk/booking/6-a-side-3g-half-pitch/)

Council 场馆映射证据是官网 [Pitch and court booking](https://www.towerhamlets.gov.uk/lgnl/leisure_and_culture/sport_and_physical_activity/book_a_court_or_pitch.aspx) 的 “Book Stepney Green Park 3G Pitch” 链接，目标正是用户给出的 achieveservice URL。静态入口不足以确认内部流程；同日后续浏览器验证停在只提供注册/登录的 `Before you begin` 页面，点击后显示登录表单，详情见 [网站验证记录](website-validation.md)。表单内部场地选项仍需登录核实。[表单入口](https://towerhamlets-self.achieveservice.com/service/Book_a_sports_pitch)

Council 条款原文：“Bookings to be confirmed by payment online and can only be made two days in advance.” 这句话不能单独确定它意指“最多提前两天”还是“须至少提前两天”；也未说明按自然日还是精确 48 小时计算，应检查实际日历及向场馆核实，代码中暂标记 `release_rule=unverified`。[Conditions of hire Stepney Astro Turf](https://www.towerhamlets.gov.uk/lgnl/leisure_and_culture/sport_and_physical_activity/Conditions-of-hire-Stepney-Astro-Turf.aspx)

## PlayFootball 占位证据与边界

[官网条款页](https://www.playfootball.net/tc) 的 Online bookings 一节直接链接 [在线预订条款 PDF](https://playfootball-public-assets.s3.eu-west-2.amazonaws.com/PF-BookingAgentOnlineBookingTerms.pdf)，文件标注更新于 2025-03-17。第 2.1 条通常允许提前 28 天，第 2.2 条要求预订时付清，且未付款订单最多保留 30 分钟，第 2.5–2.6 条描述 Stripe 付款。

因此，“检测到空位 → 创建未付款预订 → 用户付款”的设计对这两个场馆有公开条款依据。不过 30 分钟是上限，不是每次恰好 30 分钟的保证；创建预订的触发步骤、订单是否绑定会话、能否分享支付链接、实时 expiry 字段以及当前库存行为，本次均未验证。完成在线 checkout 会涉及接受条款，应避免把“选择时段”“进入结账”“已生成有效占位”和“付款成功”混为一谈。[在线预订条款 PDF](https://playfootball-public-assets.s3.eu-west-2.amazonaws.com/PF-BookingAgentOnlineBookingTerms.pdf)

两场馆页面均宣传单次预订可提前 30 天，并提供固定周租询价入口；通用条款的 28 天与场馆页的 30 天有差异。产品应采用日历实际可选日期并记录来源，不能硬编码一个数字作为保证。[Westferry 场馆页](https://www.playfootball.net/venues/canary-wharf/book-a-pitch/85/5-a-Side3GPitchHire)、[Poplar 场馆页](https://www.playfootball.net/venues/canary-wharf-poplar/book-a-pitch/88/7-a-Side3GPitchHire)

## GGCB 对实现有影响的条款

GGCB FAQ 说明固定周租至少为同场地、同时段连续三个月，整个初始固定期须预付；可登记候补。这是想长期固定踢球时的另一条场馆官方路径，不等于本工具已取得周租资格。[GGCB FAQ](https://ggcb.co.uk/faqs/)

官网政策页链接的 2026 年 4 月 v2.0 政策，第 5.3 节设一般每周两场的公平使用规则，并列本地球队/俱乐部的区别及额外网站场次规则；第 5.6 节列在线支付提供商 Pay360/Worldpay。开发前应把适用配额作为配置并核实用户类别，避免自动流程超额。政策未给出单次线上未付款订单的可靠锁场 TTL，不能从购物篮外观或通用电商软件默认值推导锁场能力。[GGCB 政策 PDF](https://ggcb.co.uk/wp-content/uploads/2026/09/GGCB-Lettings-Policy-and-Terms-Conditions.pdf)

## 技术结论：推断与待验证事项

以下是基于上述证据的实现建议，不是网站现有接口或能力的已验证事实：

- 四个链接至少对应三套系统：GGCB、Tower Hamlets achieveservice、PlayFootball 两场馆。先实现三个独立适配器，再验证 PlayFootball 两场馆流程是否可共享。
- “未来两个月”应是持续监测目标范围；站点尚未开放的日期用 `not_released/unknown` 表示，不能算 `sold_out`。任何站点都不能根据当前公开放号说明保证立即订满两个月。
- GGCB 的 55 分钟场次须单独显示实际时长；若用户严格要求 18:00–19:00 完整 60 分钟，应排除或等待用户选择。
- 在服务端得到可验证的订单/保留标识和到期依据前，只称“发现可订场次”或“已准备结账”，不称“已锁定”。
- 未找到可据以实现的公开开发者 API 文档；浏览器页面存在 JavaScript 日历并不证明存在受支持的第三方 API。接口地址、认证、速率限制、机器人许可、验证码行为都需后续逐站验证。
- 后续最小验证应检查：可选日期边界；18:00 场次的真实结束时间；身份/居住资格和价格；从选场到预订的每个状态；未付款占位是否真实减少库存；准确到期；用户在同浏览器接手付款的可行性。

本研究未创建预订、占用场地、支付或联系场馆。

## 用户补充与动态验证

当前规格以本文首段及用户最新澄清为准：Westferry 租产品 85、Poplar 租产品 88，按网站普通租场流程，不选联赛或特殊活动。不再把 Westferry 的 6v6 许可核实作为开发门槛，也不以联赛或第三方活动替代普通租场证据。55 分钟是否接受尚未获得明确回答，实际时长必须展示。技术设计详见 [technical-framework.md](technical-framework.md)。

浏览器检查已看到 GGCB 的日期选择器及两个 PlayFootball 页面的动态库存日历（含价格/时长按钮、Booked、Available nearby）；两个 PlayFootball 普通场次均能跳转官方 partners 预订摘要。Tower Hamlets 停在登录入口。本次未完成两个月全部日期的库存扫描，也未验证从选择场次到实际占位的写入流程。日期翻页与时段加载的具体限制见 [网站验证记录](website-validation.md)。

## 普通租场账号与付款流程：公开证据补充

### GGCB

2026-10-15 对 [商品页](https://ggcb.co.uk/booking/6-a-side-3g-half-pitch/) 的只读 HTTPS GET 返回 HTML，包含以下直接证据：

```text
/wp-content/plugins/woocommerce-bookings/dist/frontend.js?ver=3.11.0
/wp-content/plugins/woocommerce-bookings/dist/frontend.css?ver=3.11.0
form class="cart" method="post"
wc_bookings_field_start_date_month / day / year
add-to-cart product value: 15397
```

这些标记足以确认该商品页面使用 WooCommerce Bookings 前端。`3.11.0` 是资源 URL 的版本参数；不能据此保证服务端真实版本。商品编号 `15397` 是当前页面观察值，仍应运行时核验。未调用页面发现的后台接口、未提交 `cart` 表单，且不能从插件通用默认值推定 GGCB 实际占位时长、订单状态、库存扣减或清理任务。

同日只读获取 [My Account](https://ggcb.co.uk/my-account/) 页面，确认有用户名/邮箱及密码登录表单、邮箱注册表单。对空购物篮会话请求 `/checkout/` 重定向至 [Basket](https://ggcb.co.uk/basket/)，因此未观察到有商品时的结账字段、访客结账是否允许、账户何时必需及付款跳转。官网另一租场商品说明先加购物篮再统一付款，可作为该站购物篮流程的旁证，但它不是足球商品锁场行为的证据。[GGCB 羽毛球商品说明](https://ggcb.co.uk/booking/sports-hall-badminton/)

官网注册说明要求账单地址准确匹配，以通过 AVS；该说明在固定周租注册页，不能自动扩展成单次租场必须另行提交固定周租申请。线上支付提供商以前述 2026 政策的 Pay360/Worldpay 为公开依据，实际 checkout 提供商仍需后续验证。[GGCB 注册说明](https://ggcb.co.uk/register-interest/)、[2026 政策](https://ggcb.co.uk/wp-content/uploads/2026/09/GGCB-Lettings-Policy-and-Terms-Conditions.pdf)

### Tower Hamlets / Stepney Green

用户给的 [表单入口](https://towerhamlets-self.achieveservice.com/service/Book_a_sports_pitch) 显示注册和登录入口。只读跟随其登录链接，重定向至 `/authapi/auth?provider=ssauth&uri=%2FRenderAchieveForms`，得到邮箱类型的 Username 与 Password 字段及 POST 登录表单。没有提交凭据，没有证实内部日历、选场、订单或支付流程。[官方登录入口](https://towerhamlets-self.achieveservice.com/login?appName=Self&lang=en&return_url=%2FRenderAchieveForms)

公开政策要求线上付款确认并携带付款收据；没有可靠的未付款持有时限或支付服务商说明。本次公开 HTML 研究无法确认访客路径是否存在、强制账户的具体步骤或支付页面能否在另一设备接手。[Stepney 租用条款](https://www.towerhamlets.gov.uk/lgnl/leisure_and_culture/sport_and_physical_activity/Conditions-of-hire-Stepney-Astro-Turf.aspx)

### PlayFootball 两个普通租场产品

产品 85 和 88 的普通 One-time booking 页面都说明选时间后刷借记卡/信用卡付款。官方 [My Account](https://www.playfootball.net/my-account) 页面要求先选常用场馆，并宣传登录后管理付款和未来预订；这能证实账户服务存在，但不能证实普通租场必须先注册、一定支持访客结账，或登录会跨两场馆复用。账号页面混有球队/赛程功能，不应把联赛 AutoPay 规则当作本任务单次场租支付规则。[Westferry 产品 85](https://www.playfootball.net/venues/canary-wharf/book-a-pitch/85/5-a-Side3GPitchHire)、[Poplar 产品 88](https://www.playfootball.net/venues/canary-wharf-poplar/book-a-pitch/88/7-a-Side3GPitchHire)

普通租场的公开付款依据仍是官网链接的在线预订条款所述 Stripe，以及最多 30 分钟未付款保留。准确登录要求、联系人/账单字段、用户付款接手方式由动态验证报告记录，不从账号宣传页面推定。[在线预订条款](https://playfootball-public-assets.s3.eu-west-2.amazonaws.com/PF-BookingAgentOnlineBookingTerms.pdf)

## Stepney Green 三分之一场：正常价格与资格

官网价目表将成人定义为 16 岁及以上，按居住资格、年龄和时间收费。周一至周四 18:00–19:00 落在工作日 18:00–22:00 高峰时段；公开列出的正常成人三分之一场租是：

| 资格 | 官网列价，每小时 | 使用限制 |
| --- | --- | --- |
| Tower Hamlets borough resident | £34 | 必须真实符合居民类别，不能因场馆位于 Tower Hamlets 就选择此价 |
| Non-borough resident | £38 | 不符合居民类别时的公开正常成人价 |

这是 [官方价目页](https://www.towerhamlets.gov.uk/lgnl/leisure_and_culture/sport_and_physical_activity/Stepney_Green_astroturf_football_pitch_hire_prices.aspx) 的公开展示，**不是已核实的实时 checkout 报价**；官网入口仍引用 2022/23 收费信息，且条款允许改价，应以实际普通租场表单返回价格记录并提醒差异，不硬编码扣款金额。未找到该场地居民价的具体证明材料、团队全员/组织者居住条件或验证方式，需从实际流程确认。

成人与儿童混合预订按成人费率。儿童、学校或特殊优惠价格不适用于尚未核实资格的普通成人组；场地仅可开展足球相关活动。[Stepney 租用条款](https://www.towerhamlets.gov.uk/lgnl/leisure_and_culture/sport_and_physical_activity/Conditions-of-hire-Stepney-Astro-Turf.aspx)、[官方价目页](https://www.towerhamlets.gov.uk/lgnl/leisure_and_culture/sport_and_physical_activity/Stepney_Green_astroturf_football_pitch_hire_prices.aspx)

本次补充仅作公开页面 GET 和来源检索；未注册账号、提交预订、占位、付款或联系场馆。动态浏览器验证与框架由独立文档继续记录。
