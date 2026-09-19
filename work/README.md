# 本地测试资产

`work/` 仅用于隔离的开发验收数据，不属于生产运行目录，也不会进入 Windows 安装包。

其中 `work/alpha-install/user-data` 是安装、升级和数据持久化验收使用的历史测试目录。保留它只为复核测试记录；生产版 PrivateRadar 和正式 `privateradar-workbuddy` 均不得读取或写入该目录。

当前 Windows 用户的唯一正式数据目录是：

`C:\Users\Example\AppData\Roaming\PrivateRadar`

正式数据库是：

`C:\Users\Example\AppData\Roaming\PrivateRadar\private-radar.db`
