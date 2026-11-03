# Agent Note: CI 浏览器失败直接发布 GitHub 注释

Status: implemented

## Problem

Playwright 的列表报告只把失败详情写入执行日志，GitHub 检查可能仅留下退出码。日志下载服务不可达时，检查结果无法指出失败用例、位置及断言，阻碍定位真实回归。

## Decision

CI 同时使用 Playwright 内置的 `list` 和 `github` reporter，保留原控制台日志，并将具体失败发布为 GitHub 检查注释。本地继续使用列表报告。浏览器入口与验收范围仍由[测试策略](../../../testing.md#用户界面验证)维护。

## Alternatives considered

- 仅依赖下载日志：下载链路不可用时缺少独立诊断入口。
- 自行解析控制台并创建注释：重复现有 reporter，额外承担转义与格式兼容责任。
- 只使用 GitHub reporter：削弱本地与下载日志的连续可读性，保留原列表更方便核对。

## Consequences

失败用例可以通过 GitHub 检查注释及 API 直接读取，不依赖日志文件下载。该配置只增加失败信息的呈现，不改变断言、测试超时、worker、重试次数、合成数据或真实模型运行边界。
